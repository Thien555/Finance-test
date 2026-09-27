/**
 * (2) BUILD: RawOrders → AccountingEvent (+ BuildBatch, ExceptionLog)
 *  - Phạm vi ComCode: build trọn đơn (OrderId + ngày giao) liên quan tới ComCode đó (engine orderRowsInScope)
 *  - Engine buildOrderEvents sinh draft; engine reconcileEvents đối chiếu với event trong DB → kế hoạch ghi
 *  - Event cũ cùng khóa: NEW/ERROR/SKIPPED → thay thế ; POSTED → giữ nguyên (báo nếu nguồn đã đổi)
 *  - Event cũ không còn sinh ra nữa: chưa post → xóa ; đã POSTED → giữ + cảnh báo
 *    (gồm cả event của SourceID đã chết — dòng nguồn đã đổi ngày giao / OrderId — thuộc đơn đang build hoặc trong phạm vi build)
 *  - Item đã POSTED dưới khóa khác (đổi mapping ComCode, đổi RuleSeq, đổi ngày giao) → draft ghi ERROR, chống ghi sổ trùng
 *  - Kỳ đã khóa sổ (guide §6.12): engine vẫn chạy trên mọi dòng trong phạm vi (lọc trước làm SourceID trông như đã chết →
 *    xóa nhầm event/exception); reconcileEvents bỏ qua draft/event thuộc kỳ khóa, SQL thay/xóa/heal thêm `notLocked`; dòng raw
 *    thuộc kỳ khóa (ComCode theo mapping hiện tại hoặc ComCode đã lưu) giữ BuildStatus cũ; exception kỳ khóa giữ nguyên;
 *    phần bị bỏ qua tóm tắt bằng exception INFO PERIOD_LOCKED
 */
import { and, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, buildBatch, rawOrders } from "@/lib/db/schema";
import { buildOrderEvents, ORDER_JOURNAL_TYPE_CODES, ORDERS_DATA_SOURCE, orderRowsInScope } from "@/lib/engine/build-orders";
import { orderSourceId, orderTransactionId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { firstLocked, LockTally, lockKey, orderRowRefs } from "@/lib/engine/period-lock";
import { reconcileEvents } from "@/lib/engine/reconcile-events";
import {
  chunk,
  deleteExceptionsByKeys,
  describeScope,
  insertExceptions,
  loadMasterIndex,
  loadPeriodLocks,
  notLocked,
  periodOfDateColumn,
  replaceLockSummaries,
  type Scope,
  scopeWhere,
} from "./common";

export interface BuildSummary {
  BuildBatchID: number;
  Status: "SUCCESS" | "FAILED";
  scope: string;
  SourceRows: number;
  FulfilledRows: number;
  SkippedRows: number;
  ErrorRows: number;
  EventsCreated: number;
  EventsReplaced: number;
  EventsUnchangedPosted: number;
  EventsRemoved: number;
  /** Event bị chặn (ghi ERROR) vì cùng nghiệp vụ đã POSTED dưới khóa khác — xem ExceptionType POSTED_KEY_CHANGED */
  EventsBlocked: number;
  /** Event ghi vào DB với PostStatus ERROR (thiếu seller, bị chặn...) */
  EventsError: number;
  ZeroAmountSkipped: number;
  /** Số exception đã ghi (kể cả tóm tắt INFO PERIOD_LOCKED) */
  Exceptions: number;
  /** Draft thuộc kỳ đã khóa sổ → không ghi (guide §6.12) */
  LockedSkipped: number;
  /** Draft ở kỳ mở đụng event thuộc kỳ khóa (cùng khóa → không ghi; trùng item → ghi ERROR) — exception ERROR PERIOD_LOCKED */
  LockedConflicts: number;
  /** Dòng raw thuộc kỳ khóa → giữ nguyên BuildStatus */
  LockedRows: number;
  /** Các kỳ khóa lần Build này đã bỏ qua, dạng "COMCODE|YYYYMM" (sort) */
  LockedPeriods: string[];
  ErrorMessage?: string;
}

export function runBuildOrders(scope: Scope = {}): BuildSummary {
  const db = getDb();
  const [batch] = db
    .insert(buildBatch)
    .values({
      DataSource: ORDERS_DATA_SOURCE,
      ComCodeList: scope.comCode ?? null,
      PeriodFrom: scope.periodFrom ?? null,
      PeriodTo: scope.periodTo ?? null,
      StartedAt: nowIso(),
      Status: "RUNNING",
    })
    .returning()
    .all();

  const summary: BuildSummary = {
    BuildBatchID: batch.BuildBatchID,
    Status: "SUCCESS",
    scope: describeScope(scope),
    SourceRows: 0,
    FulfilledRows: 0,
    SkippedRows: 0,
    ErrorRows: 0,
    EventsCreated: 0,
    EventsReplaced: 0,
    EventsUnchangedPosted: 0,
    EventsRemoved: 0,
    EventsBlocked: 0,
    EventsError: 0,
    ZeroAmountSkipped: 0,
    Exceptions: 0,
    LockedSkipped: 0,
    LockedConflicts: 0,
    LockedRows: 0,
    LockedPeriods: [],
  };

  try {
    const index = loadMasterIndex(db);

    // Đọc raw theo scope (kỳ tính theo FulfilledAt)
    const where = [];
    if (scope.periodFrom) where.push(gte(periodOfDateColumn(rawOrders.FulfilledAt), scope.periodFrom));
    if (scope.periodTo) where.push(lte(periodOfDateColumn(rawOrders.FulfilledAt), scope.periodTo));
    const periodRows = db
      .select()
      .from(rawOrders)
      .where(where.length ? and(...where) : undefined)
      .all();
    // Event đang có trong phạm vi build
    const scopeEvents = db
      .selectDistinct({ SourceID: accountingEvent.SourceID, OrderID: accountingEvent.OrderID })
      .from(accountingEvent)
      .where(
        and(
          eq(accountingEvent.DataSource, ORDERS_DATA_SOURCE),
          ...scopeWhere(accountingEvent, { comCode: scope.comCode, periodFrom: scope.periodFrom, periodTo: scope.periodTo }),
        ),
      )
      .all();
    // Có ComCode: build trọn đơn có dòng map vào ComCode đó, hoặc đang có event của ComCode đó trong kỳ (mapping đã đổi đi)
    const scopeEventSourceIds = scope.comCode ? scopeEvents.flatMap((e) => (e.SourceID ? [e.SourceID] : [])) : [];
    const rows = orderRowsInScope(periodRows, index, scope.comCode ?? null, scopeEventSourceIds);

    const result = buildOrderEvents(rows, index);
    const now = nowIso();

    // Khóa exception có thể sinh ra ở lần build này → xóa exception cũ trùng khóa
    const exceptionKeys: string[] = [...ORDER_JOURNAL_TYPE_CODES];
    for (const r of rows) {
      exceptionKeys.push(r.ItemCode);
      if (r.FulfilledAt) {
        for (const jtc of ORDER_JOURNAL_TYPE_CODES) exceptionKeys.push(`${orderTransactionId(r.OrderId, r.FulfilledAt)}|${jtc}`);
      }
    }
    for (const rule of index.masters.lineRules) exceptionKeys.push(`${rule.JournalTypeCode}|${rule.RuleSeq}`);

    const sourceIdSet = new Set(rows.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)));
    const orderIdSet = new Set(rows.map((r) => r.OrderId));
    // + đơn có event trong phạm vi nhưng không còn dòng nào được build (dòng đã đổi ngày giao sang kỳ khác / đổi OrderId)
    const orderIds = [...orderIdSet, ...new Set(scopeEvents.flatMap((e) => (e.OrderID && !orderIdSet.has(e.OrderID) ? [e.OrderID] : [])))];

    const built = db.transaction((tx) => {
      // Kỳ khóa đọc trong transaction, dùng cho mọi bước ghi bên dưới
      const locks = loadPeriodLocks(tx);
      const tally = new LockTally();

      // SourceID còn dòng nguồn (mọi kỳ, mọi ComCode). Build toàn bộ thì rows đã là mọi dòng
      const liveSourceIds = new Set(sourceIdSet);
      if (scope.comCode || scope.periodFrom || scope.periodTo) {
        for (const c of chunk(orderIds, 500)) {
          for (const r of tx.select({ OrderId: rawOrders.OrderId, FulfilledAt: rawOrders.FulfilledAt }).from(rawOrders).where(inArray(rawOrders.OrderId, c)).all()) {
            if (r.FulfilledAt) liveSourceIds.add(orderSourceId(r.OrderId, r.FulfilledAt));
          }
        }
      }

      // Event hiện có của các đơn (mọi ComCode, mọi ngày giao) chia 3 nhóm:
      //  - SourceID đang build → đối chiếu, thay thế / xóa / cảnh báo
      //  - SourceID đã chết → như trên (chưa post thì xóa; POSTED thì cảnh báo và chặn draft trùng item)
      //  - SourceID còn dòng nguồn ngoài phạm vi build → chỉ lấy event POSTED để phát hiện item đã ghi sổ
      //    (+ event thuộc kỳ khóa ở mọi trạng thái: không thay / xóa được nên item của nó cũng chặn draft trùng)
      const existing: AccountingEventRow[] = [];
      const relatedPosted: AccountingEventRow[] = [];
      const deadSourceIds = new Set<string>();
      for (const c of chunk(orderIds, 500)) {
        for (const e of tx
          .select()
          .from(accountingEvent)
          .where(and(eq(accountingEvent.DataSource, ORDERS_DATA_SOURCE), inArray(accountingEvent.OrderID, c)))
          .all()) {
          const sourceId = e.SourceID ?? "";
          if (sourceIdSet.has(sourceId)) {
            existing.push(e);
          } else if (!liveSourceIds.has(sourceId)) {
            existing.push(e);
            deadSourceIds.add(sourceId);
            exceptionKeys.push(`${e.TransactionID}|${e.JournalTypeCode.trim().toUpperCase()}`);
          } else if (e.PostStatus === "POSTED" || locks.isLocked(e)) {
            relatedPosted.push(e);
          }
        }
      }

      const plan = reconcileEvents({ drafts: result.events, existing, relatedPosted, deadSourceIds, isLocked: (x) => locks.isLocked(x) });
      // Chốt thứ 2: SQL không bao giờ sửa / xóa event thuộc kỳ khóa (không kỳ nào khóa → [] → SQL như cũ)
      const unlocked = notLocked(locks, accountingEvent.ComCode, accountingEvent.Period);

      for (const { rawRowIds: _raw, ...draft } of plan.insert) {
        tx.insert(accountingEvent).values({ ...draft, BuildBatchID: batch.BuildBatchID, AddDate: now }).run();
      }
      for (const {
        id,
        draft: { rawRowIds: _raw, ...draft },
      } of plan.replace) {
        tx.update(accountingEvent)
          .set({
            ...draft,
            PostedDocNum: null,
            PostingGroupKey: null,
            PostBatchID: null,
            PostedAt: null,
            BuildBatchID: batch.BuildBatchID,
            ModifiedDate: now,
          })
          .where(and(eq(accountingEvent.AccountingEventID, id), ne(accountingEvent.PostStatus, "POSTED"), ...unlocked))
          .run();
      }
      for (const c of chunk(plan.remove, 500)) {
        tx.delete(accountingEvent)
          .where(and(inArray(accountingEvent.AccountingEventID, c), ne(accountingEvent.PostStatus, "POSTED"), ...unlocked))
          .run();
      }
      // Chỉ bổ sung dữ liệu truy vết cho event POSTED cũ, nội dung bút toán không đổi → không đổi ModifiedDate
      for (const { id, ItemCodes } of plan.healItemCodes) {
        tx.update(accountingEvent)
          .set({ ItemCodes })
          .where(
            and(eq(accountingEvent.AccountingEventID, id), eq(accountingEvent.PostStatus, "POSTED"), isNull(accountingEvent.ItemCodes), ...unlocked),
          )
          .run();
      }

      // Dòng raw thuộc kỳ khóa (ComCode theo mapping hiện tại hoặc ComCode đã lưu × kỳ ngày giao) giữ nguyên BuildStatus
      const rowById = new Map(rows.map((r) => [r.RawOrderID, r]));
      let lockedRows = 0;
      for (const [rawOrderId, s] of result.rawStatus) {
        const row = rowById.get(rawOrderId);
        const lockedRef = row && firstLocked(locks, orderRowRefs(row, index));
        if (lockedRef) {
          lockedRows++;
          tally.add(ORDERS_DATA_SOURCE, lockedRef, "rows");
          continue;
        }
        tx.update(rawOrders)
          .set({ BuildStatus: s.status, BuildMessage: s.message, ComCode: s.comCode })
          .where(eq(rawOrders.RawOrderID, rawOrderId))
          .run();
      }
      for (const l of plan.locked) if (l.reason === "DRAFT_LOCKED") tally.add(ORDERS_DATA_SOURCE, l.draft, "events");

      // Exception thuộc kỳ khóa: bản cũ giữ nguyên (khóa exception Orders không chứa ComCode nên cần điều kiện SQL theo `locks`),
      // bản mới bỏ. ERROR PERIOD_LOCKED của plan gắn với draft kỳ mở nên luôn được ghi
      const exceptions = [...result.exceptions, ...plan.exceptions].filter((e) => !locks.isLocked(e));
      const lockSummaries = tally.toExceptions("Build");
      deleteExceptionsByKeys(tx, "BUILD", exceptionKeys, locks);
      insertExceptions(tx, "BUILD", batch.BuildBatchID, exceptions);
      replaceLockSummaries(tx, "BUILD", [ORDERS_DATA_SOURCE], scope, lockSummaries, batch.BuildBatchID);

      // Kỳ khóa đã bỏ qua: draft / dòng raw đã đếm + event cũ thuộc kỳ khóa lẽ ra bị thay / xóa / cảnh báo
      const lockedPeriods = new Set(tally.periods);
      for (const e of existing) if (locks.isLocked(e)) lockedPeriods.add(lockKey(e.ComCode, e.Period));
      return { plan, lockedRows, exceptionCount: exceptions.length + lockSummaries.length, lockedPeriods: [...lockedPeriods].sort() };
    });
    const { plan } = built;

    // Bộ đếm chỉ gán sau khi transaction commit (lỗi giữa chừng → rollback, không báo số ảo)
    summary.EventsCreated = plan.insert.length;
    summary.EventsReplaced = plan.replace.length;
    summary.EventsUnchangedPosted = plan.unchangedPosted;
    summary.EventsRemoved = plan.remove.length;
    summary.EventsBlocked = plan.blocked;
    summary.Exceptions = built.exceptionCount;
    summary.LockedSkipped = plan.locked.filter((l) => l.reason === "DRAFT_LOCKED").length;
    summary.LockedConflicts = plan.lockedConflicts;
    summary.LockedRows = built.lockedRows;
    summary.LockedPeriods = built.lockedPeriods;
    summary.SourceRows = result.stats.sourceRows;
    summary.FulfilledRows = result.stats.fulfilledRows;
    summary.SkippedRows = result.stats.skippedRows;
    summary.ErrorRows = result.stats.errorRows;
    summary.EventsError = [...plan.insert, ...plan.replace.map((r) => r.draft)].filter((e) => e.PostStatus === "ERROR").length;
    summary.ZeroAmountSkipped = result.stats.zeroAmountSkipped;

    db.update(buildBatch)
      .set({
        EndedAt: nowIso(),
        Status: "SUCCESS",
        SourceRows: summary.SourceRows,
        EventsCreated: summary.EventsCreated,
        EventsReplaced: summary.EventsReplaced,
        EventsError: summary.EventsError,
        SkippedRows: summary.SkippedRows,
      })
      .where(eq(buildBatch.BuildBatchID, batch.BuildBatchID))
      .run();
  } catch (err) {
    summary.Status = "FAILED";
    summary.ErrorMessage = err instanceof Error ? err.message : String(err);
    db.update(buildBatch)
      .set({ EndedAt: nowIso(), Status: "FAILED", ErrorMessage: summary.ErrorMessage })
      .where(eq(buildBatch.BuildBatchID, batch.BuildBatchID))
      .run();
  }
  return summary;
}
