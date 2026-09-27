/**
 * Điều chỉnh vận hành (tài liệu §15):
 *  - Unpost          : xóa GLTrans, event POSTED → NEW
 *  - Unbuild         : xóa AccountingEvent chưa post, RawOrders → NOT_BUILT (trừ dòng có item còn nằm trong event chưa bị xóa);
 *                      raw PayPal / Stripe / PIPO → NOT_BUILT chỉ khi dòng không còn event nào (để trống nguồn = mọi nguồn)
 *  - Unpost + Unbuild: làm lần lượt 2 bước trên
 * Mọi hàm hỗ trợ preview (chỉ đếm, không sửa dữ liệu).
 * Kỳ khóa sổ (guide §6.12): chứng từ, event, dòng raw và exception thuộc (ComCode, kỳ) đang LOCKED được giữ nguyên,
 * chỉ báo số lượng (`locked*`). "Xóa dữ liệu test" bị từ chối khi còn kỳ khóa.
 */
import { and, count, eq, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accountingEvent, exceptionLog, glTrans, postingBatch, rawOrders, rawPaypal, rawPipo, rawStripe } from "@/lib/db/schema";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { nowIso } from "@/lib/engine/parse";
import { lockKey, lockMsg, type PeriodLocks } from "@/lib/engine/period-lock";
import { BadRequestError } from "@/lib/errors";
import type { SourceKey } from "@/lib/sources/columns";
import { countBuiltSourceRows, countLockedSourceRows, resetSourceRawStatus, SOURCE_DATA_SOURCES } from "./build-source";
import {
  chunk,
  type DbOrTx,
  deleteExceptionsByDataSource,
  loadPeriodLocks,
  lockedWhere,
  notLocked,
  periodOfDateColumn,
  type Scope,
  scopeWhere,
} from "./common";

export interface UnpostResult {
  preview: boolean;
  events: number;
  glLines: number;
  documents: number;
  batches: number[];
  /** Chứng từ trong phạm vi thuộc kỳ khóa → giữ nguyên */
  lockedDocuments: number;
  /** Event POSTED trong phạm vi thuộc kỳ khóa → giữ nguyên */
  lockedEvents: number;
  /** Các kỳ khóa đã bỏ qua, dạng "COMCODE|YYYYMM" (sort, không trùng) */
  lockedPeriods: string[];
}

type UnpostOptions = { scope?: Scope; postBatchId?: number | null; preview?: boolean };

export function unpost(options: UnpostOptions): UnpostResult {
  // Chạy thật: đọc kỳ khóa, chọn chứng từ và xóa trong cùng 1 transaction (gọi từ Unbuild thì thành savepoint)
  return options.preview ? unpostSteps(options) : getDb().$client.transaction(() => unpostSteps(options))();
}

function unpostSteps(options: UnpostOptions): UnpostResult {
  const db = getDb();
  const scope = options.scope ?? {};
  const locks = loadPeriodLocks(db);
  const base: SQL[] = [eq(accountingEvent.PostStatus, "POSTED"), ...scopeWhere(accountingEvent, scope)];
  if (options.postBatchId) base.push(eq(accountingEvent.PostBatchID, options.postBatchId));

  // Chứng từ thuộc kỳ khóa: chỉ đếm. 1 DocNum luôn thuộc đúng 1 công ty × 1 kỳ (Bulk gom theo ComCode + ngày);
  // vẫn loại cả chứng từ có event kỳ khóa để không bao giờ xóa dở 1 chứng từ
  const lockedDocs = new Set<string>();
  const lockedPeriods = new Set<string>();
  let lockedEvents = 0;
  if (!locks.isEmpty) {
    const groups = db
      .select({ doc: accountingEvent.PostedDocNum, ComCode: accountingEvent.ComCode, Period: accountingEvent.Period, n: count() })
      .from(accountingEvent)
      .where(and(...base, lockedWhere(locks, accountingEvent.ComCode, accountingEvent.Period)))
      .groupBy(accountingEvent.PostedDocNum, accountingEvent.ComCode, accountingEvent.Period)
      .all();
    for (const g of groups) {
      if (g.doc) lockedDocs.add(g.doc);
      lockedPeriods.add(lockKey(g.ComCode, g.Period));
      lockedEvents += g.n;
    }
  }

  const docNums = [
    ...new Set(
      db
        .selectDistinct({ doc: accountingEvent.PostedDocNum })
        .from(accountingEvent)
        .where(and(...base, ...notLocked(locks, accountingEvent.ComCode, accountingEvent.Period)))
        .all()
        .map((r) => r.doc)
        .filter((d): d is string => !!d && !lockedDocs.has(d)),
    ),
  ];

  let events = 0;
  let glLines = 0;
  const batches = new Set<number>();
  for (const c of chunk(docNums, 500)) {
    events += db.select({ n: count() }).from(accountingEvent).where(and(eq(accountingEvent.PostStatus, "POSTED"), inArray(accountingEvent.PostedDocNum, c))).all()[0].n;
    glLines += db.select({ n: count() }).from(glTrans).where(inArray(glTrans.DocNum, c)).all()[0].n;
    for (const r of db.selectDistinct({ id: glTrans.PostBatchID }).from(glTrans).where(inArray(glTrans.DocNum, c)).all()) batches.add(r.id);
  }

  const result: UnpostResult = {
    preview: !!options.preview,
    events,
    glLines,
    documents: docNums.length,
    batches: [...batches],
    lockedDocuments: lockedDocs.size,
    lockedEvents,
    lockedPeriods: [...lockedPeriods].sort(),
  };
  if (options.preview || docNums.length === 0) return result;

  const now = nowIso();
  db.transaction((tx) => {
    for (const c of chunk(docNums, 500)) {
      tx.delete(glTrans).where(inArray(glTrans.DocNum, c)).run();
      tx.update(accountingEvent)
        .set({ PostStatus: "NEW", PostedDocNum: null, PostingGroupKey: null, PostBatchID: null, PostedAt: null, ErrorStage: null, ErrorMessage: null, ModifiedDate: now })
        .where(and(eq(accountingEvent.PostStatus, "POSTED"), inArray(accountingEvent.PostedDocNum, c)))
        .run();
    }
    // Batch không còn dòng GL nào → đánh dấu UNPOSTED (còn dòng GL, VD của kỳ khóa → giữ SUCCESS)
    for (const id of batches) {
      const [{ n }] = tx.select({ n: count() }).from(glTrans).where(eq(glTrans.PostBatchID, id)).all();
      if (n === 0) {
        tx.update(postingBatch).set({ Status: "UNPOSTED", ModifiedDate: now }).where(eq(postingBatch.PostBatchID, id)).run();
      }
    }
  });
  return result;
}

export interface UnbuildResult {
  preview: boolean;
  unposted: UnpostResult | null;
  deletedEvents: number;
  postedEventsKept: number;
  rawRowsReset: number;
  /** Event trong phạm vi (mọi trạng thái) thuộc kỳ khóa → giữ nguyên */
  lockedEvents: number;
  /** Dòng raw đã build trong phạm vi thuộc kỳ khóa → giữ BuildStatus */
  lockedRawRows: number;
  /** Các kỳ khóa đã bỏ qua, dạng "COMCODE|YYYYMM" (sort, không trùng) */
  lockedPeriods: string[];
}

type UnbuildOptions = { scope?: Scope; includePosted?: boolean; preview?: boolean };

export function unbuild(options: UnbuildOptions): UnbuildResult {
  // Unpost + Unbuild trong 1 transaction (transaction con thành savepoint): lỗi giữa chừng thì rollback cả phần Unpost
  return options.preview ? unbuildSteps(options) : getDb().$client.transaction(() => unbuildSteps(options))();
}

function unbuildSteps(options: UnbuildOptions): UnbuildResult {
  const db = getDb();
  const scope = options.scope ?? {};
  // Chạy thật: đang trong transaction của unbuild() → kỳ khóa đọc cùng snapshot với phần xóa
  const locks = loadPeriodLocks(db);

  const unposted = options.includePosted ? unpost({ scope, preview: options.preview }) : null;

  // Nguồn ngân hàng/PSP: 1 dòng raw ⇄ 1 bộ event nên không cần guard theo item như Orders —
  // xóa event chưa post trong phạm vi rồi reset BuildStatus các dòng raw của đúng bảng đó không còn event nào.
  const bankSource = sourceKeyOfDataSource(scope.dataSource);
  if (bankSource) return unbuildBankSource(db, bankSource, scope, options, unposted, locks);

  // Preview của "Unpost + Unbuild": event POSTED trong scope coi như sẽ được unpost trước
  const simulateUnpost = !!options.preview && !!unposted;

  // Event thuộc kỳ khóa nằm ngoài eventScope → không bị xóa và được tính là "còn lại" (survives) → raw của item giữ BUILT
  const eventScope = [...scopeWhere(accountingEvent, scope), ...notLocked(locks, accountingEvent.ComCode, accountingEvent.Period)];
  const countEvents = (...extra: SQL[]) =>
    db.select({ n: count() }).from(accountingEvent).where(and(...eventScope, ...extra)).all()[0].n;
  const deletable = countEvents(ne(accountingEvent.PostStatus, "POSTED"));
  const postedInScope = countEvents(eq(accountingEvent.PostStatus, "POSTED"));

  // Event bị xóa ở lần Unbuild này (preview "Unpost + Unbuild": POSTED trong scope coi như đã unpost) và event còn lại
  const inScope = and(...eventScope) ?? sql`1`;
  const removedNow = simulateUnpost ? inScope : and(inScope, ne(accountingEvent.PostStatus, "POSTED"))!;
  const survives = sql`coalesce(${removedNow}, 0) = 0`;
  const itemsOfEvents = (where: SQL) =>
    sql`(SELECT j.value FROM ${accountingEvent}, json_each(${accountingEvent.ItemCodes}) j
      WHERE ${accountingEvent.DataSource} = ${ORDERS_DATA_SOURCE} AND ${accountingEvent.ItemCodes} IS NOT NULL AND ${where})`;

  const rawScope: SQL[] = [];
  if (scope.comCode) {
    // raw theo ComCode đang lưu, hoặc item nằm trong event bị xóa (ComCode của event có thể khác raw khi mapping đã đổi)
    rawScope.push(
      or(eq(rawOrders.ComCode, scope.comCode), isNull(rawOrders.ComCode), sql`${rawOrders.ItemCode} IN ${itemsOfEvents(removedNow)}`)!,
    );
  }
  const rawPeriod = periodOfDateColumn(rawOrders.FulfilledAt);
  if (scope.periodFrom) rawScope.push(gte(rawPeriod, scope.periodFrom));
  if (scope.periodTo) rawScope.push(lte(rawPeriod, scope.periodTo));
  const rawWhere: SQL[] = [ne(rawOrders.BuildStatus, "NOT_BUILT"), ...rawScope];
  // Dòng raw thuộc kỳ khóa (ComCode đang lưu × kỳ FulfilledAt) giữ nguyên BuildStatus
  rawWhere.push(...notLocked(locks, rawOrders.ComCode, rawPeriod));
  // Item còn nằm trong event không bị xóa (POSTED, ComCode/kỳ khác, kỳ khóa) → raw giữ BUILT để import không thay được dòng đó.
  // Event cũ chưa có ItemCodes → giữ cả đơn.
  rawWhere.push(sql`${rawOrders.ItemCode} NOT IN ${itemsOfEvents(survives)}`);
  rawWhere.push(
    sql`${rawOrders.OrderId} NOT IN (SELECT ${accountingEvent.OrderID} FROM ${accountingEvent}
      WHERE ${accountingEvent.DataSource} = ${ORDERS_DATA_SOURCE} AND ${accountingEvent.ItemCodes} IS NULL
        AND ${accountingEvent.OrderID} IS NOT NULL AND ${survives})`,
  );
  const rawCondition = and(...rawWhere);
  const [{ n: rawRows }] = db.select({ n: count() }).from(rawOrders).where(rawCondition).all();

  // Phần giữ lại vì kỳ khóa: event trong phạm vi + raw đã build trong phạm vi (chỉ đếm)
  const locked = lockedEventsInScope(db, scope, locks);
  let lockedRawRows = 0;
  if (!locks.isEmpty) {
    const groups = db
      .select({ ComCode: rawOrders.ComCode, Period: rawPeriod, n: count() })
      .from(rawOrders)
      .where(and(ne(rawOrders.BuildStatus, "NOT_BUILT"), ...rawScope, lockedWhere(locks, rawOrders.ComCode, rawPeriod)))
      .groupBy(rawOrders.ComCode, rawPeriod)
      .all();
    for (const g of groups) {
      locked.periods.add(lockKey(g.ComCode, g.Period));
      lockedRawRows += g.n;
    }
  }

  // Để trống ô nguồn: eventScope xóa event chưa POSTED của MỌI nguồn → dòng raw PayPal / Stripe / PIPO không còn event nào
  // cũng về NOT_BUILT (như Unbuild từng nguồn); dòng còn event (POSTED, kỳ khóa) giữ BUILT
  const bankSources = scope.dataSource ? [] : (Object.keys(SOURCE_DATA_SOURCES) as SourceKey[]);
  let bankRawRows = 0;
  for (const source of bankSources) {
    bankRawRows += countBuiltSourceRows(db, source, scope, locks, survives);
    const n = countLockedSourceRows(db, source, scope, locks);
    if (n > 0) {
      lockedRawRows += n;
      for (const p of lockedSourcePeriods(db, source, scope, locks)) locked.periods.add(p);
    }
  }

  const result: UnbuildResult = {
    preview: !!options.preview,
    unposted,
    deletedEvents: simulateUnpost ? deletable + postedInScope : deletable,
    postedEventsKept: simulateUnpost ? 0 : postedInScope,
    rawRowsReset: rawRows + bankRawRows,
    lockedEvents: locked.events,
    lockedRawRows,
    lockedPeriods: [...locked.periods].sort(),
  };
  if (options.preview) return result;

  db.transaction((tx) => {
    tx.delete(accountingEvent).where(and(...eventScope, ne(accountingEvent.PostStatus, "POSTED"))).run();
    tx.update(rawOrders).set({ BuildStatus: "NOT_BUILT", BuildMessage: null }).where(rawCondition).run();

    const exWhere: SQL[] = [eq(exceptionLog.BatchType, "BUILD")];
    if (scope.comCode) exWhere.push(eq(exceptionLog.ComCode, scope.comCode));
    if (scope.periodFrom) exWhere.push(gte(exceptionLog.Period, scope.periodFrom));
    if (scope.periodTo) exWhere.push(lte(exceptionLog.Period, scope.periodTo));
    // Exception của kỳ khóa (kể cả tóm tắt INFO PERIOD_LOCKED) giữ nguyên
    exWhere.push(...notLocked(locks, exceptionLog.ComCode, exceptionLog.Period));
    tx.delete(exceptionLog).where(and(...exWhere)).run();

    for (const source of bankSources) {
      resetSourceRawStatus(tx, source, scope, locks);
      deleteExceptionsByDataSource(tx, "BUILD", SOURCE_DATA_SOURCES[source], scope, locks);
    }
  });
  return result;
}

/** Event trong phạm vi thuộc kỳ khóa (mọi trạng thái) — số lượng + các kỳ "COMCODE|YYYYMM" */
function lockedEventsInScope(db: DbOrTx, scope: Scope, locks: PeriodLocks): { events: number; periods: Set<string> } {
  const out = { events: 0, periods: new Set<string>() };
  if (locks.isEmpty) return out;
  const groups = db
    .select({ ComCode: accountingEvent.ComCode, Period: accountingEvent.Period, n: count() })
    .from(accountingEvent)
    .where(and(...scopeWhere(accountingEvent, scope), lockedWhere(locks, accountingEvent.ComCode, accountingEvent.Period)))
    .groupBy(accountingEvent.ComCode, accountingEvent.Period)
    .all();
  for (const g of groups) {
    out.events += g.n;
    out.periods.add(lockKey(g.ComCode, g.Period));
  }
  return out;
}

/** Nguồn ngân hàng/PSP theo AccountingEvent.DataSource; null nếu là Orders hoặc không giới hạn nguồn */
function sourceKeyOfDataSource(dataSource: string | null | undefined): SourceKey | null {
  if (!dataSource) return null;
  const want = dataSource.trim().toUpperCase();
  const hit = (Object.entries(SOURCE_DATA_SOURCES) as [SourceKey, string][]).find(([, ds]) => ds.toUpperCase() === want);
  return hit ? hit[0] : null;
}

const RAW_SOURCE_TABLES = { paypal: rawPaypal, stripe: rawStripe, pipo: rawPipo };

/** Kỳ khóa của dòng raw ngân hàng/PSP đã build trong phạm vi (ComCode × kỳ PostingDate) — chỉ để báo cáo */
function lockedSourcePeriods(db: DbOrTx, source: SourceKey, scope: Scope, locks: PeriodLocks): string[] {
  const t = RAW_SOURCE_TABLES[source];
  const period = periodOfDateColumn(t.PostingDate);
  const where: SQL[] = [ne(t.BuildStatus, "NOT_BUILT"), lockedWhere(locks, t.ComCode, period)];
  if (scope.comCode) where.push(eq(t.ComCode, scope.comCode));
  if (scope.periodFrom) where.push(gte(period, scope.periodFrom));
  if (scope.periodTo) where.push(lte(period, scope.periodTo));
  return db
    .selectDistinct({ ComCode: t.ComCode, Period: period })
    .from(t)
    .where(and(...where))
    .all()
    .map((r) => lockKey(r.ComCode, r.Period));
}

function unbuildBankSource(
  db: ReturnType<typeof getDb>,
  source: SourceKey,
  scope: Scope,
  options: UnbuildOptions,
  unposted: UnpostResult | null,
  locks: PeriodLocks,
): UnbuildResult {
  // Event / raw / exception thuộc kỳ khóa nằm ngoài mọi điều kiện xóa/reset bên dưới
  const eventScope = [...scopeWhere(accountingEvent, scope), ...notLocked(locks, accountingEvent.ComCode, accountingEvent.Period)];
  const countEvents = (...extra: SQL[]) => db.select({ n: count() }).from(accountingEvent).where(and(...eventScope, ...extra)).all()[0].n;
  const deletable = countEvents(ne(accountingEvent.PostStatus, "POSTED"));
  const postedInScope = countEvents(eq(accountingEvent.PostStatus, "POSTED"));
  const simulateUnpost = !!options.preview && !!unposted;

  // Event còn lại sau lần Unbuild này (preview "Unpost + Unbuild": POSTED trong phạm vi coi như đã unpost) — dòng raw còn event
  // (POSTED được giữ, kỳ khóa) giữ BUILT để Import vẫn chặn sửa dòng (§13.3 #21 cũ)
  const inScope = and(...eventScope) ?? sql`1`;
  const removedNow = simulateUnpost ? inScope : and(inScope, ne(accountingEvent.PostStatus, "POSTED"))!;
  const survives = sql`coalesce(${removedNow}, 0) = 0`;

  const locked = lockedEventsInScope(db, scope, locks);
  const lockedRawRows = locks.isEmpty ? 0 : countLockedSourceRows(db, source, scope, locks);
  if (lockedRawRows > 0) for (const p of lockedSourcePeriods(db, source, scope, locks)) locked.periods.add(p);

  const result: UnbuildResult = {
    preview: !!options.preview,
    unposted,
    deletedEvents: simulateUnpost ? deletable + postedInScope : deletable,
    postedEventsKept: simulateUnpost ? 0 : postedInScope,
    rawRowsReset: countBuiltSourceRows(db, source, scope, locks, survives),
    lockedEvents: locked.events,
    lockedRawRows,
    lockedPeriods: [...locked.periods].sort(),
  };
  if (options.preview) return result;

  db.transaction((tx) => {
    tx.delete(accountingEvent).where(and(...eventScope, ne(accountingEvent.PostStatus, "POSTED"))).run();
    // Sau khi xóa: event còn trong DB chính là event còn lại → chỉ reset dòng không còn event nào
    resetSourceRawStatus(tx, source, scope, locks);
    deleteExceptionsByDataSource(tx, "BUILD", SOURCE_DATA_SOURCES[source], scope, locks);
  });
  return result;
}

/** Xóa toàn bộ dữ liệu test (giữ master data và bảng kỳ kế toán). Từ chối khi còn kỳ khóa sổ */
export function resetTransactionalData() {
  const db = getDb();
  const sqlite = db.$client;
  const tables = [
    "GLTrans",
    "AccountingEvent",
    "PostingBatch",
    "BuildBatch",
    "ExceptionLog",
    "RawOrders",
    "RawPaypal",
    "RawStripe",
    "RawPipo",
    "ImportBatch",
  ];
  sqlite.transaction(() => {
    // Kiểm tra trong transaction: kỳ khóa đọc cùng snapshot với lệnh xóa. AccountingPeriod/AccountingPeriodLog không bị xóa
    const locks = loadPeriodLocks(db);
    if (!locks.isEmpty) throw new BadRequestError(lockMsg.resetRefused(locks));
    for (const t of tables) sqlite.prepare(`DELETE FROM "${t}"`).run();
    const placeholders = tables.map(() => "?").join(",");
    sqlite.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...tables);
  })();
}
