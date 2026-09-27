/**
 * Kỳ kế toán & khóa sổ (guide §6.12): lưới công ty × kỳ kèm số liệu việc dở, khóa / mở khóa, lịch sử.
 * Quy tắc thuần (chọn kỳ cần khóa, kiểm tra việc dở, tên / lý do) ở src/lib/engine/period-lock.ts; file này chỉ đọc/ghi DB.
 *
 *  - Không có dòng AccountingPeriod = OPEN. Khóa = upsert Status LOCKED; mở khóa = Status OPEN + tên + lý do.
 *  - Mỗi lần khóa / mở khóa ghi 1 dòng AccountingPeriodLog kèm ChecksSnapshot (việc dở lúc thao tác). Kỳ đã khóa sẵn bỏ qua, không ghi log.
 *  - Kỳ của dữ liệu: AccountingEvent/GLTrans theo cột Period; RawOrders theo FulfilledAt; raw PayPal/Stripe/PIPO theo PostingDate.
 */
import Decimal from "decimal.js";
import { and, asc, count, desc, eq, gte, isNotNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { type AppDb, getDb } from "@/lib/db/client";
import {
  type AccountingPeriodLogRow,
  type AccountingPeriodRow,
  accountingEvent,
  accountingPeriod,
  accountingPeriodLog,
  company,
  exceptionLog,
  glTrans,
  rawOrders,
  rawPaypal,
  rawPipo,
  rawStripe,
} from "@/lib/db/schema";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { nowIso } from "@/lib/engine/parse";
import {
  actorError,
  type CompanyPeriod,
  describePeriod,
  isBalanced,
  isValidPeriod,
  laterLockedPeriods,
  type LockRequest,
  lockKey,
  parseLockKey,
  type PendingIssue,
  pendingIssues,
  type PeriodCounts,
  type PeriodStatus,
  resolveLockTargets,
  unlockReasonError,
} from "@/lib/engine/period-lock";
import { BadRequestError } from "@/lib/errors";
import { PERIOD_RULES } from "@/lib/field-docs";
import { SOURCE_META } from "@/lib/sources/columns";
import { type DbOrTx, loadPeriodLocks, periodOfDateColumn, scopeWhere } from "./common";

// ───────────────────────────── Kiểu dữ liệu (trang /periods dùng `import type`) ─────────────────────────────

export interface PeriodFilter {
  comCode?: string | null;
  periodFrom?: string | null; // YYYYMM
  periodTo?: string | null; // YYYYMM
}

/** Số dòng raw của 1 nguồn trong 1 ô: chưa build, lỗi build, tổng (mọi BuildStatus) */
export interface RawCounts {
  notBuilt: number;
  error: number;
  total: number;
}

export interface EventCounts {
  NEW: number;
  ERROR: number;
  POSTED: number;
  SKIPPED: number;
}

/** Số liệu dữ liệu của 1 ô công ty × kỳ */
export interface PeriodData {
  /** Theo DataSource: ORDERS, PAYPAL, STRIPE, PIPO (luôn đủ 4 khóa) */
  rawBySource: Record<string, RawCounts>;
  rawNotBuilt: number;
  rawError: number;
  events: EventCounts;
  glLines: number;
  glDocs: number;
  /** Σ AccountedDr / Σ AccountedCr của GLTrans (tiền quy đổi FncCurr) */
  dr: number;
  cr: number;
  balanced: boolean;
}

/** 1 ô của lưới: trạng thái kỳ + số liệu + việc dở */
export interface PeriodCell extends CompanyPeriod, PeriodData {
  Status: PeriodStatus;
  /** Đã có dòng AccountingPeriod (từng khóa) */
  HasRow: boolean;
  LockedBy: string | null;
  LockedAt: string | null;
  UnlockedBy: string | null;
  UnlockedAt: string | null;
  UnlockReason: string | null;
  Note: string | null;
  issues: PendingIssue[];
}

export interface PeriodCompany {
  ComCode: string;
  CompanyName: string | null;
  FunctionalCurrency: string | null;
  /** false = ComCode chỉ có trong dữ liệu, không có trong bảng Company → không khóa được */
  InCompanyTable: boolean;
}

/** Dòng raw chưa xác định công ty (ComCode trống) theo kỳ × nguồn — không khóa theo công ty được */
export interface UnassignedRaw {
  Period: string;
  DataSource: string;
  NotBuilt: number;
  Error: number;
}

export interface PeriodGrid {
  companies: PeriodCompany[];
  /** Kỳ YYYYMM, mới nhất trước */
  periods: string[];
  cells: PeriodCell[];
  unassigned: UnassignedRaw[];
  /** Tổng số kỳ đang LOCKED (mọi công ty, không theo bộ lọc) */
  lockedCount: number;
}

/** Kiểm tra việc dở của 1 ô trước khi khóa / mở khóa (cũng là nội dung ChecksSnapshot) */
export interface PendingCheck extends CompanyPeriod, PeriodData {
  Status: PeriodStatus;
  /** Dòng raw cùng kỳ chưa xác định công ty (chưa build + lỗi) */
  rawNoComCode: number;
  issues: PendingIssue[];
}

export interface LockPreview {
  preview: true;
  /** Các ô sẽ khóa kèm việc dở */
  targets: PendingCheck[];
  /** Ô đã khóa sẵn → bỏ qua */
  alreadyLocked: CompanyPeriod[];
}

export interface LockResult {
  preview: false;
  locked: CompanyPeriod[];
  alreadyLocked: CompanyPeriod[];
  targets: PendingCheck[];
}

export interface UnlockPreview {
  preview: true;
  ComCode: string;
  Period: string;
  /** Kỳ sau của cùng công ty vẫn đang khóa (chỉ cảnh báo) */
  laterLockedPeriods: string[];
  check: PendingCheck;
  row: AccountingPeriodRow;
}

export interface UnlockResult {
  preview: false;
  ComCode: string;
  Period: string;
  laterLockedPeriods: string[];
  check: PendingCheck;
  /** Số exception INFO PERIOD_LOCKED (tóm tắt phần bị bỏ qua) của kỳ đã dọn */
  removedSummaries: number;
}

export interface LockInput extends LockRequest {
  actor?: string | null;
  note?: string | null;
  preview?: boolean;
}

export interface UnlockInput {
  comCode?: string | null;
  period?: string | null;
  actor?: string | null;
  reason?: string | null;
  preview?: boolean;
}

export interface PeriodLogFilter {
  comCode?: string | null;
  period?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  action?: string | null;
  page?: number | null;
  pageSize?: number | null;
}

// ───────────────────────────── Tổng hợp số liệu theo công ty × kỳ ─────────────────────────────

/** Bảng raw theo nguồn: cột công ty + cột ngày quyết định kỳ */
interface RawSpec {
  dataSource: string;
  table: SQLiteTable;
  comCode: SQLiteColumn;
  date: SQLiteColumn;
  status: SQLiteColumn;
}

const RAW_SPECS: RawSpec[] = [
  { dataSource: ORDERS_DATA_SOURCE, table: rawOrders, comCode: rawOrders.ComCode, date: rawOrders.FulfilledAt, status: rawOrders.BuildStatus },
  { dataSource: SOURCE_META.paypal.dataSource, table: rawPaypal, comCode: rawPaypal.ComCode, date: rawPaypal.PostingDate, status: rawPaypal.BuildStatus },
  { dataSource: SOURCE_META.stripe.dataSource, table: rawStripe, comCode: rawStripe.ComCode, date: rawStripe.PostingDate, status: rawStripe.BuildStatus },
  { dataSource: SOURCE_META.pipo.dataSource, table: rawPipo, comCode: rawPipo.ComCode, date: rawPipo.PostingDate, status: rawPipo.BuildStatus },
];

const PERIOD_RE = /^\d{6}$/;
const normCom = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
/** Cùng quy tắc với lockKey: UPPER(TRIM(ComCode)), NULL → '' */
const comSql = (col: SQLiteColumn) => sql<string>`upper(trim(coalesce(${col}, '')))`;
const round2 = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

function normFilter(f: PeriodFilter): PeriodFilter {
  const out = { comCode: normCom(f.comCode) || null, periodFrom: f.periodFrom?.trim() || null, periodTo: f.periodTo?.trim() || null };
  for (const p of [out.periodFrom, out.periodTo]) {
    if (p && !PERIOD_RE.test(p)) throw new BadRequestError(`Kỳ "${p}" phải có dạng YYYYMM`);
  }
  return out;
}

const emptyData = (): PeriodData => ({
  rawBySource: Object.fromEntries(RAW_SPECS.map((s) => [s.dataSource, { notBuilt: 0, error: 0, total: 0 }])),
  rawNotBuilt: 0,
  rawError: 0,
  events: { NEW: 0, ERROR: 0, POSTED: 0, SKIPPED: 0 },
  glLines: 0,
  glDocs: 0,
  dr: 0,
  cr: 0,
  balanced: true,
});

export interface PeriodAggregate {
  /** lockKey "COMCODE|YYYYMM" → số liệu (chỉ ô có dữ liệu) */
  data: Map<string, PeriodData>;
  unassigned: UnassignedRaw[];
}

/**
 * Đếm dữ liệu theo công ty × kỳ: mỗi bảng 1 câu GROUP BY rồi ghép theo lockKey.
 * Lọc công ty: raw không có ComCode vẫn được đếm (vào `unassigned`) vì không thuộc công ty nào.
 */
export function aggregate(db: DbOrTx, filter: PeriodFilter = {}): PeriodAggregate {
  const f = normFilter(filter);
  const data = new Map<string, PeriodData>();
  const cell = (com: string | null | undefined, period: string) => {
    const key = lockKey(com, period);
    let d = data.get(key);
    if (!d) {
      d = emptyData();
      data.set(key, d);
    }
    return d;
  };

  // AccountingEvent theo PostStatus
  const eventRows = db
    .select({ com: accountingEvent.ComCode, p: accountingEvent.Period, s: accountingEvent.PostStatus, n: count() })
    .from(accountingEvent)
    .where(and(...scopeWhere(accountingEvent, f)))
    .groupBy(accountingEvent.ComCode, accountingEvent.Period, accountingEvent.PostStatus)
    .all();
  for (const r of eventRows) {
    if (!isValidPeriod(r.p)) continue;
    const d = cell(r.com, r.p);
    if (r.s in d.events) d.events[r.s as keyof EventCounts] += r.n;
  }

  // GLTrans: số dòng, số chứng từ, Σ Nợ / Có quy đổi
  const glRows = db
    .select({
      com: glTrans.ComCode,
      p: glTrans.Period,
      lines: count(),
      docs: sql<number>`count(distinct ${glTrans.DocNum})`,
      dr: sql<number>`round(coalesce(sum(${glTrans.AccountedDr}), 0), 2)`,
      cr: sql<number>`round(coalesce(sum(${glTrans.AccountedCr}), 0), 2)`,
    })
    .from(glTrans)
    .where(and(...scopeWhere(glTrans, f)))
    .groupBy(glTrans.ComCode, glTrans.Period)
    .all();
  for (const r of glRows) {
    if (!isValidPeriod(r.p)) continue;
    const d = cell(r.com, r.p);
    d.glLines += r.lines;
    d.glDocs += r.docs;
    d.dr = round2(new Decimal(d.dr).plus(r.dr ?? 0));
    d.cr = round2(new Decimal(d.cr).plus(r.cr ?? 0));
  }

  // Raw theo nguồn × BuildStatus; ComCode trống → unassigned
  const unassigned = new Map<string, UnassignedRaw>();
  for (const spec of RAW_SPECS) {
    const com = comSql(spec.comCode);
    const period = periodOfDateColumn(spec.date);
    const where: SQL[] = [isNotNull(spec.date)];
    if (f.comCode) where.push(or(sql`${com} = ${f.comCode}`, sql`${com} = ''`)!);
    if (f.periodFrom) where.push(gte(period, f.periodFrom));
    if (f.periodTo) where.push(lte(period, f.periodTo));
    const rows = db
      .select({ com, p: period, s: sql<string>`${spec.status}`, n: count() })
      .from(spec.table)
      .where(and(...where))
      .groupBy(com, period, spec.status)
      .all();
    for (const r of rows) {
      if (!isValidPeriod(r.p)) continue;
      const notBuilt = r.s === "NOT_BUILT" ? r.n : 0;
      const error = r.s === "ERROR" ? r.n : 0;
      if (!r.com) {
        const key = `${r.p}|${spec.dataSource}`;
        const u = unassigned.get(key) ?? { Period: r.p, DataSource: spec.dataSource, NotBuilt: 0, Error: 0 };
        u.NotBuilt += notBuilt;
        u.Error += error;
        unassigned.set(key, u);
        continue;
      }
      const d = cell(r.com, r.p);
      const src = d.rawBySource[spec.dataSource];
      src.notBuilt += notBuilt;
      src.error += error;
      src.total += r.n;
      d.rawNotBuilt += notBuilt;
      d.rawError += error;
    }
  }

  for (const d of data.values()) d.balanced = isBalanced(d.dr, d.cr);
  return {
    data,
    unassigned: [...unassigned.values()]
      .filter((u) => u.NotBuilt + u.Error > 0)
      .sort((a, b) => b.Period.localeCompare(a.Period) || a.DataSource.localeCompare(b.DataSource)),
  };
}

const countsOf = (d: PeriodData, rawNoComCode = 0): PeriodCounts => ({
  rawNotBuilt: d.rawNotBuilt,
  rawError: d.rawError,
  eventsNew: d.events.NEW,
  eventsError: d.events.ERROR,
  eventsPosted: d.events.POSTED,
  eventsSkipped: d.events.SKIPPED,
  rawTotal: Object.values(d.rawBySource).reduce((n, r) => n + r.total, 0),
  glLines: d.glLines,
  dr: d.dr,
  cr: d.cr,
  rawNoComCode,
});

/** Việc dở của 1 ô (kèm raw cùng kỳ chưa xác định công ty) */
function checkOf(agg: PeriodAggregate, target: CompanyPeriod, status: PeriodStatus): PendingCheck {
  const d = agg.data.get(lockKey(target.ComCode, target.Period)) ?? emptyData();
  const rawNoComCode = agg.unassigned.filter((u) => u.Period === target.Period).reduce((n, u) => n + u.NotBuilt + u.Error, 0);
  return { ComCode: target.ComCode, Period: target.Period, Status: status, ...d, rawNoComCode, issues: pendingIssues(countsOf(d, rawNoComCode)) };
}

/** Nội dung lưu vào AccountingPeriodLog.ChecksSnapshot (bỏ các cột đã có trên dòng log) */
function snapshotOf(check: PendingCheck): string {
  const { ComCode: _c, Period: _p, Status: _s, ...rest } = check;
  return JSON.stringify(rest);
}

/** Kỳ liền trước: "202601" → "202512" */
function prevPeriod(p: string): string {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(4, 6));
  return m <= 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, "0")}`;
}

const findRow = (db: DbOrTx, comCode: string, period: string) =>
  db
    .select()
    .from(accountingPeriod)
    .where(and(eq(accountingPeriod.ComCode, comCode), eq(accountingPeriod.Period, period)))
    .get();

// ───────────────────────────── Lưới công ty × kỳ ─────────────────────────────

/**
 * Lưới trang Kỳ kế toán: ô = hợp của (công ty, kỳ) có dữ liệu và (công ty, kỳ) có dòng AccountingPeriod.
 * Lọc đủ cả kỳ từ + đến thì mọi tháng trong khoảng đều hiện (tối đa 120 tháng mới nhất), để khóa trước kỳ chưa có dữ liệu.
 */
export function listPeriodGrid(filter: PeriodFilter = {}): PeriodGrid {
  const db = getDb();
  const f = normFilter(filter);
  const agg = aggregate(db, f);

  const rowWhere: SQL[] = [];
  if (f.comCode) rowWhere.push(eq(accountingPeriod.ComCode, f.comCode));
  if (f.periodFrom) rowWhere.push(gte(accountingPeriod.Period, f.periodFrom));
  if (f.periodTo) rowWhere.push(lte(accountingPeriod.Period, f.periodTo));
  const rows = new Map(
    db
      .select()
      .from(accountingPeriod)
      .where(and(...rowWhere))
      .all()
      .map((r) => [lockKey(r.ComCode, r.Period), r]),
  );

  const cells: PeriodCell[] = [...new Set([...agg.data.keys(), ...rows.keys()])].map((key) => {
    const { ComCode, Period } = parseLockKey(key);
    const row = rows.get(key);
    const d = agg.data.get(key) ?? emptyData();
    return {
      ComCode,
      Period,
      Status: row?.Status === "LOCKED" ? "LOCKED" : "OPEN",
      HasRow: !!row,
      LockedBy: row?.LockedBy ?? null,
      LockedAt: row?.LockedAt ?? null,
      UnlockedBy: row?.UnlockedBy ?? null,
      UnlockedAt: row?.UnlockedAt ?? null,
      UnlockReason: row?.UnlockReason ?? null,
      Note: row?.Note ?? null,
      ...d,
      issues: pendingIssues(countsOf(d)),
    };
  });
  cells.sort((a, b) => b.Period.localeCompare(a.Period) || a.ComCode.localeCompare(b.ComCode));

  const companies: PeriodCompany[] = db
    .select()
    .from(company)
    .orderBy(asc(company.ComCode))
    .all()
    .filter((c) => !f.comCode || normCom(c.ComCode) === f.comCode)
    .map((c) => ({ ComCode: normCom(c.ComCode), CompanyName: c.CompanyName, FunctionalCurrency: c.FunctionalCurrency, InCompanyTable: true }));
  const known = new Set(companies.map((c) => c.ComCode));
  for (const com of [...new Set(cells.map((c) => c.ComCode))].sort()) {
    if (com && !known.has(com)) companies.push({ ComCode: com, CompanyName: null, FunctionalCurrency: null, InCompanyTable: false });
  }

  const periods = new Set(cells.map((c) => c.Period));
  if (f.periodFrom && f.periodTo && isValidPeriod(f.periodFrom) && isValidPeriod(f.periodTo)) {
    // Đi lùi từ kỳ đến: khoảng > 120 tháng thì giữ 120 tháng MỚI nhất (tháng tương lai là tháng hay cần khóa trước)
    for (let p = f.periodTo, i = 0; p >= f.periodFrom && i < 120; p = prevPeriod(p), i++) periods.add(p);
  }

  return {
    companies,
    periods: [...periods].sort().reverse(),
    cells,
    unassigned: agg.unassigned,
    lockedCount: loadPeriodLocks(db).size,
  };
}

// ───────────────────────────── Khóa ─────────────────────────────

/** Khoảng kỳ cần tổng hợp cho 1 yêu cầu khóa (tránh quét mọi kỳ khi chỉ khóa vài ô) */
function lockRange(req: LockRequest): PeriodFilter {
  if (req.targets?.length) {
    const periods = req.targets.map((t) => (t.period ?? "").trim()).filter(isValidPeriod).sort();
    return periods.length ? { periodFrom: periods[0], periodTo: periods[periods.length - 1] } : {};
  }
  const through = req.throughPeriod?.trim();
  return isValidPeriod(through) ? { periodTo: through } : {};
}

/**
 * Khóa kỳ: `targets` (đúng các ô) hoặc `comCodes` + `throughPeriod` (mọi kỳ ≤ P có dữ liệu và chính P).
 * `preview` chỉ trả việc dở; chạy thật ghi trong 1 transaction đồng bộ, kỳ đã khóa sẵn bỏ qua (không ghi log).
 * Việc dở chỉ cảnh báo, không chặn — nội dung được lưu vào ChecksSnapshot của dòng log.
 */
export function lockPeriods(input: LockInput): LockPreview | LockResult {
  const db = getDb();
  const note = input.note?.trim() || null;
  if (note && [...note].length > PERIOD_RULES.textMaxLength) throw new BadRequestError(`Ghi chú tối đa ${PERIOD_RULES.textMaxLength} ký tự`);

  const req: LockRequest = { targets: input.targets, comCodes: input.comCodes, throughPeriod: input.throughPeriod };
  const locks = loadPeriodLocks(db);
  const agg = aggregate(db, lockRange(req));
  const periodsWithData = new Map<string, string[]>();
  for (const key of agg.data.keys()) {
    const { ComCode, Period } = parseLockKey(key);
    periodsWithData.set(ComCode, [...(periodsWithData.get(ComCode) ?? []), Period]);
  }
  const companies = new Set(
    db
      .select({ ComCode: company.ComCode })
      .from(company)
      .all()
      .map((c) => normCom(c.ComCode)),
  );

  const resolved = resolveLockTargets(req, { companies, periodsWithData, locks });
  if (resolved.errors.length) throw new BadRequestError(resolved.errors.join("; "));
  const targets = resolved.toLock.map((t) => checkOf(agg, t, "OPEN"));
  if (input.preview) return { preview: true, targets, alreadyLocked: resolved.alreadyLocked };

  const err = actorError(input.actor);
  if (err) throw new BadRequestError(err);
  const actor = input.actor!.trim();
  const now = nowIso();
  const locked: CompanyPeriod[] = [];
  const alreadyLocked = [...resolved.alreadyLocked];

  db.transaction((tx) => {
    for (const check of targets) {
      const t: CompanyPeriod = { ComCode: check.ComCode, Period: check.Period };
      const row = findRow(tx, t.ComCode, t.Period);
      if (row?.Status === "LOCKED") {
        alreadyLocked.push(t);
        continue;
      }
      const set = { Status: "LOCKED", LockedBy: actor, LockedAt: now, Note: note, ModifiedDate: now };
      tx.insert(accountingPeriod)
        .values({ ...t, ...set })
        .onConflictDoUpdate({ target: [accountingPeriod.ComCode, accountingPeriod.Period], set })
        .run();
      tx.insert(accountingPeriodLog)
        .values({
          ...t,
          Action: "LOCK",
          FromStatus: row?.Status ?? "OPEN",
          ToStatus: "LOCKED",
          ActorName: actor,
          Reason: note,
          ChecksSnapshot: snapshotOf(check),
          CreatedAt: now,
        })
        .run();
      locked.push(t);
    }
  });

  return { preview: false, locked, alreadyLocked, targets };
}

// ───────────────────────────── Mở khóa ─────────────────────────────

/**
 * Mở khóa 1 kỳ: bắt buộc tên + lý do (≥ PERIOD_RULES.unlockReasonMinLength ký tự). Kỳ sau còn khóa chỉ cảnh báo.
 * Dọn luôn exception INFO PERIOD_LOCKED (tóm tắt phần bị bỏ qua) của kỳ vì không còn đúng.
 */
export function unlockPeriod(input: UnlockInput): UnlockPreview | UnlockResult {
  const db = getDb();
  const ComCode = normCom(input.comCode);
  const Period = input.period?.trim() ?? "";
  if (!ComCode) throw new BadRequestError("Thiếu ComCode");
  if (!isValidPeriod(Period)) throw new BadRequestError(`Kỳ "${Period}" không hợp lệ (YYYYMM, tháng 01–12)`);
  const row = findRow(db, ComCode, Period);
  if (row?.Status !== "LOCKED") throw new BadRequestError(`${describePeriod({ ComCode, Period })} đang không khóa`);

  const later = laterLockedPeriods(loadPeriodLocks(db), ComCode, Period);
  const check = checkOf(aggregate(db, { comCode: ComCode, periodFrom: Period, periodTo: Period }), { ComCode, Period }, "LOCKED");
  if (input.preview) return { preview: true, ComCode, Period, laterLockedPeriods: later, check, row };

  const err = actorError(input.actor) ?? unlockReasonError(input.reason);
  if (err) throw new BadRequestError(err);
  const actor = input.actor!.trim();
  const reason = input.reason!.trim();
  const now = nowIso();

  const removedSummaries = db.transaction((tx) => {
    // Đọc lại trong transaction: có thể đã được mở khóa ở tab khác
    if (findRow(tx, ComCode, Period)?.Status !== "LOCKED") throw new BadRequestError(`${describePeriod({ ComCode, Period })} đang không khóa`);
    tx.update(accountingPeriod)
      .set({ Status: "OPEN", UnlockedBy: actor, UnlockedAt: now, UnlockReason: reason, ModifiedDate: now })
      .where(and(eq(accountingPeriod.ComCode, ComCode), eq(accountingPeriod.Period, Period)))
      .run();
    tx.insert(accountingPeriodLog)
      .values({
        ComCode,
        Period,
        Action: "UNLOCK",
        FromStatus: "LOCKED",
        ToStatus: "OPEN",
        ActorName: actor,
        Reason: reason,
        ChecksSnapshot: snapshotOf(check),
        CreatedAt: now,
      })
      .run();
    return tx
      .delete(exceptionLog)
      .where(
        and(
          eq(exceptionLog.ExceptionType, "PERIOD_LOCKED"),
          eq(exceptionLog.Severity, "INFO"),
          eq(exceptionLog.ComCode, ComCode),
          eq(exceptionLog.Period, Period),
        ),
      )
      .run().changes;
  });

  return { preview: false, ComCode, Period, laterLockedPeriods: later, check, removedSummaries };
}

// ───────────────────────────── Lịch sử & tóm tắt ─────────────────────────────

export function listPeriodLog(f: PeriodLogFilter = {}): { rows: AccountingPeriodLogRow[]; total: number } {
  const db = getDb();
  const where: SQL[] = [];
  const comCode = normCom(f.comCode);
  const period = f.period?.trim();
  const action = f.action?.trim().toUpperCase();
  if (action && action !== "LOCK" && action !== "UNLOCK") throw new BadRequestError(`Action "${action}" không hợp lệ (LOCK | UNLOCK)`);
  for (const p of [period, f.periodFrom, f.periodTo]) {
    if (p && !PERIOD_RE.test(p)) throw new BadRequestError(`Kỳ "${p}" phải có dạng YYYYMM`);
  }
  if (comCode) where.push(eq(accountingPeriodLog.ComCode, comCode));
  if (period) where.push(eq(accountingPeriodLog.Period, period));
  if (f.periodFrom) where.push(gte(accountingPeriodLog.Period, f.periodFrom));
  if (f.periodTo) where.push(lte(accountingPeriodLog.Period, f.periodTo));
  if (action) where.push(eq(accountingPeriodLog.Action, action));

  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const cond = and(...where);
  const rows = db
    .select()
    .from(accountingPeriodLog)
    .where(cond)
    .orderBy(desc(accountingPeriodLog.ID))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const [{ total }] = db.select({ total: count() }).from(accountingPeriodLog).where(cond).all();
  return { rows, total };
}

/** Số kỳ đang khóa + danh sách "COMCODE|YYYYMM" (VD hiển thị cảnh báo trên dashboard) */
export function lockedPeriodSummary(db: AppDb = getDb()): { count: number; keys: string[] } {
  const locks = loadPeriodLocks(db);
  return { count: locks.size, keys: locks.keys };
}
