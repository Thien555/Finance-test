/**
 * Kỳ kế toán & khóa sổ (guide §6.12, tài liệu BA §4.3) — quy tắc thuần, không đọc DB.
 *
 * - Kỳ = công ty × tháng (ComCode + YYYYMM). Không có dòng AccountingPeriod = OPEN.
 * - Kỳ LOCKED: không Import / thay dòng raw, không Build (tạo/thay/xóa event), không Post, không Unpost / Unbuild.
 *   Lệnh phạm vi rộng bỏ qua phần kỳ khóa và báo số lượng (LockTally → exception INFO PERIOD_LOCKED).
 * - Khóa so khớp theo trim + uppercase ComCode (rule 2); `lockKey` cũng là biểu thức SQL `notLocked` ở services/common.ts.
 */
import Decimal from "decimal.js";
import type { RawOrderRow } from "@/lib/db/schema";
import { PERIOD_RULES } from "@/lib/field-docs";
import { periodOf } from "./keys";
import type { MasterIndex } from "./masters";
import type { ExceptionDraft } from "./types";

export type PeriodStatus = "OPEN" | "LOCKED";

/** Một dòng / event / exception quy về (ComCode, Period); thiếu 1 trong 2 → không thuộc kỳ nào → không bao giờ khóa */
export interface PeriodRef {
  ComCode: string | null | undefined;
  Period: string | null | undefined;
}

export interface CompanyPeriod {
  ComCode: string;
  Period: string;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** "zeniroxpay ", "202511" → "ZENIROXPAY|202511" */
export const lockKey = (comCode: string | null | undefined, period: string | null | undefined) => `${norm(comCode)}|${(period ?? "").trim()}`;

/** "ZENIROXPAY|202511" → { ComCode, Period } */
export function parseLockKey(key: string): CompanyPeriod {
  const i = key.lastIndexOf("|");
  return { ComCode: key.slice(0, i), Period: key.slice(i + 1) };
}

/** Hiển thị: "ZENIROXPAY kỳ 202511" */
export const describePeriod = (ref: PeriodRef) => `${norm(ref.ComCode)} kỳ ${(ref.Period ?? "").trim()}`;

/** Tập kỳ đang LOCKED (đọc 1 lần cho mỗi thao tác) */
export class PeriodLocks {
  private readonly set: Set<string>;

  constructor(rows: Iterable<CompanyPeriod>) {
    this.set = new Set();
    for (const r of rows) {
      if (r.ComCode?.trim() && r.Period?.trim()) this.set.add(lockKey(r.ComCode, r.Period));
    }
  }

  static readonly NONE = new PeriodLocks([]);

  get isEmpty(): boolean {
    return this.set.size === 0;
  }

  get size(): number {
    return this.set.size;
  }

  /** Khóa "COMCODE|YYYYMM" đã sort — cũng là danh sách giá trị của điều kiện SQL */
  get keys(): string[] {
    return [...this.set].sort();
  }

  isLocked(ref: PeriodRef): boolean {
    if (this.set.size === 0 || !ref.ComCode?.trim() || !ref.Period?.trim()) return false;
    return this.set.has(lockKey(ref.ComCode, ref.Period));
  }

  /** Kỳ khóa của 1 công ty, sort tăng dần */
  periodsOf(comCode: string): string[] {
    const prefix = `${norm(comCode)}|`;
    return this.keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
}

/** Kỳ của 1 ngày YYYY-MM-DD; null nếu trống */
export const periodOfDate = (date: string | null | undefined): string | null => (date?.trim() ? periodOf(date.trim()) : null);

/**
 * Dòng RawOrders thuộc những (ComCode, kỳ) nào: ComCode theo GatewayCompanyMapping hiện tại (Build sẽ ghi vào đó)
 * và ComCode đang lưu trên dòng (event cũ nằm ở đó) × kỳ của FulfilledAt. Dòng chưa giao không thuộc kỳ nào.
 */
export function orderRowRefs(row: Pick<RawOrderRow, "ComCode" | "PaymentGatewayName" | "FulfilledAt">, index: MasterIndex): PeriodRef[] {
  const period = periodOfDate(row.FulfilledAt);
  return [
    { ComCode: index.comCodeOfGateway(row.PaymentGatewayName) ?? null, Period: period },
    { ComCode: row.ComCode, Period: period },
  ];
}

/** Ref đầu tiên bị khóa trong danh sách; undefined nếu không có */
export const firstLocked = (locks: PeriodLocks, refs: PeriodRef[]): PeriodRef | undefined => refs.find((r) => locks.isLocked(r));

// ───────────────────────────── Tóm tắt phần bị bỏ qua ─────────────────────────────

type TallyField = "rows" | "events";
const TALLY_LABEL: Record<TallyField, string> = { rows: "dòng nguồn", events: "event" };

/**
 * Đếm phần bị bỏ qua vì kỳ khóa theo DataSource × ComCode × kỳ → 1 exception INFO PERIOD_LOCKED mỗi nhóm.
 * SourceKey cố định `PERIOD_LOCKED|{DataSource}|{ComCode}|{Period}` để lần chạy sau thay thế (không cộng dồn).
 */
export class LockTally {
  private readonly groups = new Map<string, { DataSource: string; ComCode: string; Period: string; rows: number; events: number }>();

  add(dataSource: string, ref: PeriodRef, field: TallyField, n = 1) {
    if (n <= 0 || !ref.ComCode?.trim() || !ref.Period?.trim()) return;
    const ComCode = norm(ref.ComCode);
    const Period = ref.Period.trim();
    const key = `${dataSource}|${ComCode}|${Period}`;
    const g = this.groups.get(key) ?? { DataSource: dataSource, ComCode, Period, rows: 0, events: 0 };
    g[field] += n;
    this.groups.set(key, g);
  }

  get isEmpty(): boolean {
    return this.groups.size === 0;
  }

  total(field: TallyField): number {
    let n = 0;
    for (const g of this.groups.values()) n += g[field];
    return n;
  }

  /** Các kỳ khóa đã chạm tới, dạng "COMCODE|YYYYMM", sort */
  get periods(): string[] {
    return [...new Set([...this.groups.values()].map((g) => lockKey(g.ComCode, g.Period)))].sort();
  }

  /** `action`: tên thao tác hiện trong thông điệp, VD "Build", "Post" */
  toExceptions(action: string): ExceptionDraft[] {
    return [...this.groups.values()]
      .sort((a, b) => `${a.DataSource}|${a.ComCode}|${a.Period}`.localeCompare(`${b.DataSource}|${b.ComCode}|${b.Period}`))
      .map((g) => ({
        DataSource: g.DataSource,
        ComCode: g.ComCode,
        Period: g.Period,
        Severity: "INFO" as const,
        ExceptionType: "PERIOD_LOCKED" as const,
        SourceKey: lockSummaryKey(g.DataSource, g.ComCode, g.Period),
        Message:
          `${describePeriod(g)} đã khóa sổ → ${action} bỏ qua ` +
          (["rows", "events"] as TallyField[])
            .filter((f) => g[f] > 0)
            .map((f) => `${g[f]} ${TALLY_LABEL[f]}`)
            .join(", ") +
          ". Muốn ghi lại: mở khóa kỳ ở trang Kỳ kế toán (ghi lý do), chạy lại rồi khóa lại",
      }));
  }
}

export const lockSummaryKey = (dataSource: string, comCode: string, period: string) => `PERIOD_LOCKED|${dataSource}|${norm(comCode)}|${period}`;

// ───────────────────────────── Thông điệp ─────────────────────────────

const unlockHint = (ref: PeriodRef) => `mở khóa ${describePeriod(ref)} ở trang Kỳ kế toán (ghi lý do)`;

export const lockMsg = {
  /** Import: dòng thuộc kỳ khóa (giá trị mới hoặc cũ của dòng) */
  importRow: (ref: PeriodRef) => `Dòng thuộc ${describePeriod(ref)} đã khóa sổ → không nhận. Muốn ghi: ${unlockHint(ref)} rồi import lại`,
  /** Import: dòng còn nằm trong event thuộc kỳ khóa */
  importEvent: (eventId: number, ref: PeriodRef, postStatus: string) =>
    `Dòng còn nằm trong event ${eventId} (${postStatus}) thuộc ${describePeriod(ref)} đã khóa sổ → không cho thay. Muốn sửa: ${unlockHint(ref)}, ` +
    `${postStatus === "POSTED" ? "Unpost + " : ""}Unbuild kỳ đó rồi import lại`,
  /** Build: event cùng khóa đang ở kỳ khóa, dòng nguồn đã đổi sang kỳ khác (nguồn ngân hàng: khóa event không chứa ngày) */
  sameKeyLocked: (old: PeriodRef & { AccountingEventID: number; PostStatus: string }, draftPeriod: string) =>
    `Event ${old.AccountingEventID} (${old.PostStatus}) cùng khóa đang thuộc ${describePeriod(old)} đã khóa sổ, dòng nguồn nay thuộc kỳ ${draftPeriod} → không ghi. ` +
    `Muốn sửa: ${unlockHint(old)}, ${old.PostStatus === "POSTED" ? "Unpost + " : ""}Unbuild kỳ đó rồi Build lại`,
  /** Build: draft ở kỳ mở trùng item với event thuộc kỳ khóa */
  blockedByLocked: (holder: PeriodRef & { AccountingEventID: number; PostStatus: string; JournalTypeCode: string }) =>
    `Item của event này còn nằm trong event ${holder.AccountingEventID} (${holder.JournalTypeCode}, ${holder.PostStatus}) thuộc ${describePeriod(holder)} ` +
    `đã khóa sổ → chặn để không ghi sổ trùng. Muốn sửa: ${unlockHint(holder)}, ${holder.PostStatus === "POSTED" ? "Unpost + " : ""}Unbuild kỳ đó rồi Build + Post lại`,
  /** Xóa dữ liệu test khi còn kỳ khóa */
  resetRefused: (locks: PeriodLocks) => {
    const sample = locks.keys.slice(0, 5).map((k) => describePeriod(parseLockKey(k)));
    const more = locks.size > sample.length ? ` và ${locks.size - sample.length} kỳ khác` : "";
    return `Còn ${locks.size} kỳ đang khóa sổ (${sample.join(", ")}${more}) → mở khóa ở trang Kỳ kế toán trước khi xóa dữ liệu test`;
  },
};

// ───────────────────────────── Master: khóa / mở khóa ─────────────────────────────

/** YYYYMM hợp lệ: 6 chữ số, tháng 01–12 */
export function isValidPeriod(period: string | null | undefined): period is string {
  if (!period || !/^\d{6}$/.test(period)) return false;
  const month = Number(period.slice(4, 6));
  return month >= 1 && month <= 12 && Number(period.slice(0, 4)) >= 1900;
}

/** Lỗi của tên người thao tác, null nếu hợp lệ */
export function actorError(actor: string | null | undefined): string | null {
  const s = actor?.trim() ?? "";
  if (!s) return "Nhập tên người thao tác";
  if ([...s].length > PERIOD_RULES.actorMaxLength) return `Tên người thao tác tối đa ${PERIOD_RULES.actorMaxLength} ký tự`;
  return null;
}

/** Lỗi của lý do mở khóa, null nếu hợp lệ */
export function unlockReasonError(reason: string | null | undefined): string | null {
  const n = [...(reason?.trim() ?? "")].length;
  if (n < PERIOD_RULES.unlockReasonMinLength) return `Lý do mở khóa tối thiểu ${PERIOD_RULES.unlockReasonMinLength} ký tự`;
  if (n > PERIOD_RULES.textMaxLength) return `Lý do mở khóa tối đa ${PERIOD_RULES.textMaxLength} ký tự`;
  return null;
}

export interface LockRequest {
  /** Khóa đúng các ô này */
  targets?: { comCode: string; period: string }[] | null;
  /** Hoặc: khóa mọi kỳ ≤ throughPeriod có dữ liệu (và chính throughPeriod) của các công ty này */
  comCodes?: string[] | null;
  throughPeriod?: string | null;
}

export interface LockContext {
  /** ComCode có trong bảng Company (uppercase) */
  companies: ReadonlySet<string>;
  /** Kỳ có dữ liệu (raw / event / GL) theo công ty (uppercase) */
  periodsWithData: ReadonlyMap<string, readonly string[]>;
  locks: PeriodLocks;
}

export interface LockTargets {
  toLock: CompanyPeriod[];
  alreadyLocked: CompanyPeriod[];
  errors: string[];
}

/** Chuẩn hóa yêu cầu khóa → danh sách ô cần khóa (sort, không trùng) + ô đã khóa sẵn + lỗi đầu vào */
export function resolveLockTargets(req: LockRequest, ctx: LockContext): LockTargets {
  const out: LockTargets = { toLock: [], alreadyLocked: [], errors: [] };
  const hasTargets = !!req.targets?.length;
  const hasThrough = !!req.throughPeriod?.trim() || !!req.comCodes?.length;
  if (hasTargets === hasThrough) {
    out.errors.push(hasTargets ? "Chỉ chọn 1 cách: danh sách kỳ, hoặc công ty + khóa đến hết kỳ" : "Chưa chọn kỳ cần khóa");
    return out;
  }

  const wanted: CompanyPeriod[] = [];
  if (hasTargets) {
    for (const t of req.targets!) wanted.push({ ComCode: norm(t.comCode), Period: (t.period ?? "").trim() });
  } else {
    const through = req.throughPeriod?.trim() ?? "";
    if (!isValidPeriod(through)) out.errors.push(`Kỳ "${through}" không hợp lệ (YYYYMM, tháng 01–12)`);
    const comCodes = [...new Set((req.comCodes ?? []).map(norm).filter(Boolean))];
    if (comCodes.length === 0) out.errors.push("Chọn ít nhất 1 công ty");
    if (out.errors.length) return out;
    for (const com of comCodes) {
      const periods = new Set((ctx.periodsWithData.get(com) ?? []).filter((p) => isValidPeriod(p) && p <= through));
      periods.add(through);
      for (const p of periods) wanted.push({ ComCode: com, Period: p });
    }
  }

  const seen = new Set<string>();
  for (const t of wanted) {
    if (!t.ComCode) {
      out.errors.push("Thiếu ComCode");
      continue;
    }
    if (!ctx.companies.has(t.ComCode)) {
      out.errors.push(`Công ty ${t.ComCode} không có trong danh mục Company`);
      continue;
    }
    if (!isValidPeriod(t.Period)) {
      out.errors.push(`Kỳ "${t.Period}" của ${t.ComCode} không hợp lệ (YYYYMM, tháng 01–12)`);
      continue;
    }
    const key = lockKey(t.ComCode, t.Period);
    if (seen.has(key)) continue;
    seen.add(key);
    (ctx.locks.isLocked(t) ? out.alreadyLocked : out.toLock).push(t);
  }
  const byKey = (a: CompanyPeriod, b: CompanyPeriod) => a.ComCode.localeCompare(b.ComCode) || a.Period.localeCompare(b.Period);
  out.toLock.sort(byKey);
  out.alreadyLocked.sort(byKey);
  if (out.toLock.length + out.alreadyLocked.length > PERIOD_RULES.maxTargets) {
    out.errors.push(`Tối đa ${PERIOD_RULES.maxTargets} kỳ mỗi lần khóa`);
  }
  return out;
}

/** Kỳ sau `period` của cùng công ty đang khóa (mở khóa kỳ trước khi kỳ sau còn khóa chỉ cảnh báo) */
export const laterLockedPeriods = (locks: PeriodLocks, comCode: string, period: string): string[] =>
  locks.periodsOf(comCode).filter((p) => p > period);

/** Tổng Nợ = tổng Có (lệch < 0,005 coi là cân) */
export const isBalanced = (dr: number, cr: number) => new Decimal(dr || 0).minus(cr || 0).abs().lt(0.005);

/** Số liệu 1 ô công ty × kỳ, dùng cho kiểm tra trước khi khóa */
export interface PeriodCounts {
  rawNotBuilt: number;
  rawError: number;
  eventsNew: number;
  eventsError: number;
  eventsPosted: number;
  /** Event SKIPPED — không phải việc dở nhưng là dữ liệu của kỳ */
  eventsSkipped?: number;
  /** Tổng dòng raw đã xác định công ty, mọi BuildStatus (gồm BUILT / SKIPPED) — để biết kỳ có dữ liệu */
  rawTotal?: number;
  glLines: number;
  dr: number;
  cr: number;
  /** Dòng raw cùng kỳ chưa xác định được công ty (không khóa theo công ty được) */
  rawNoComCode?: number;
}

export type PendingIssueCode = "RAW_NOT_BUILT" | "RAW_ERROR" | "RAW_NO_COMCODE" | "EVENTS_NEW" | "EVENTS_ERROR" | "GL_IMBALANCED" | "NO_DATA";

export interface PendingIssue {
  code: PendingIssueCode;
  count: number;
  text: string;
}

/** Việc dở của 1 ô → cảnh báo trước khi khóa (không chặn; lưu vào lịch sử khóa) */
export function pendingIssues(c: PeriodCounts): PendingIssue[] {
  const out: PendingIssue[] = [];
  const add = (code: PendingIssueCode, count: number, text: string) => {
    if (count > 0) out.push({ code, count, text });
  };
  add("RAW_NOT_BUILT", c.rawNotBuilt, `${c.rawNotBuilt} dòng raw chưa build — khóa rồi sẽ không build được`);
  add("RAW_ERROR", c.rawError, `${c.rawError} dòng raw lỗi khi build (thiếu ComCode, JournalType…)`);
  add("RAW_NO_COMCODE", c.rawNoComCode ?? 0, `${c.rawNoComCode ?? 0} dòng raw cùng kỳ chưa xác định được công ty — không bị khóa theo công ty`);
  add("EVENTS_NEW", c.eventsNew, `${c.eventsNew} event NEW chưa Post — khóa rồi sẽ không Post được`);
  add("EVENTS_ERROR", c.eventsError, `${c.eventsError} event ERROR (thiếu partner, tỷ giá, tài khoản…)`);
  if (!isBalanced(c.dr, c.cr)) {
    add("GL_IMBALANCED", 1, `Sổ cái lệch: Σ Nợ ${new Decimal(c.dr).toFixed(2)} ≠ Σ Có ${new Decimal(c.cr).toFixed(2)}`);
  }
  // Cùng định nghĩa "kỳ có dữ liệu" với lưới và "Khóa đến hết kỳ": raw đã có công ty (mọi trạng thái), event mọi trạng thái, dòng GL
  const rawTotal = Math.max(c.rawTotal ?? 0, c.rawNotBuilt + c.rawError);
  const hasData = rawTotal + c.eventsNew + c.eventsError + c.eventsPosted + (c.eventsSkipped ?? 0) + c.glLines > 0;
  if (!hasData) out.push({ code: "NO_DATA", count: 0, text: "Kỳ chưa có dữ liệu — khóa trước để chặn nhập nhầm vào kỳ này" });
  return out;
}
