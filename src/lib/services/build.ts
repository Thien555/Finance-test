/**
 * (2) BUILD: RawOrders → AccountingEvent (+ BuildBatch, ExceptionLog)
 *  - Phạm vi ComCode: build trọn đơn (OrderId + ngày giao) liên quan tới ComCode đó (engine orderRowsInScope)
 *  - Engine buildOrderEvents sinh draft; engine reconcileEvents đối chiếu với event trong DB → kế hoạch ghi
 *  - Event cũ cùng khóa: NEW/ERROR/SKIPPED → thay thế ; POSTED → giữ nguyên (báo nếu nguồn đã đổi)
 *  - Event cũ không còn sinh ra nữa: chưa post → xóa ; đã POSTED → giữ + cảnh báo
 *    (gồm cả event của SourceID đã chết — dòng nguồn đã đổi ngày giao / OrderId — thuộc đơn đang build hoặc trong phạm vi build)
 *  - Item đã POSTED dưới khóa khác (đổi mapping ComCode, đổi RuleSeq, đổi ngày giao) → draft ghi ERROR, chống ghi sổ trùng
 */
import { and, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, buildBatch, rawOrders } from "@/lib/db/schema";
import { buildOrderEvents, ORDER_JOURNAL_TYPE_CODES, ORDERS_DATA_SOURCE, orderRowsInScope } from "@/lib/engine/build-orders";
import { orderSourceId, orderTransactionId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { reconcileEvents } from "@/lib/engine/reconcile-events";
import {
  chunk,
  deleteExceptionsByKeys,
  describeScope,
  insertExceptions,
  loadMasterIndex,
  periodOfDateColumn,
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
  Exceptions: number;
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

    const plan = db.transaction((tx) => {
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
          } else if (e.PostStatus === "POSTED") {
            relatedPosted.push(e);
          }
        }
      }

      const plan = reconcileEvents({ drafts: result.events, existing, relatedPosted, deadSourceIds });

      for (const { rawOrderIds: _raw, ...draft } of plan.insert) {
        tx.insert(accountingEvent).values({ ...draft, BuildBatchID: batch.BuildBatchID, AddDate: now }).run();
      }
      for (const {
        id,
        draft: { rawOrderIds: _raw, ...draft },
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
          .where(and(eq(accountingEvent.AccountingEventID, id), ne(accountingEvent.PostStatus, "POSTED")))
          .run();
      }
      for (const c of chunk(plan.remove, 500)) {
        tx.delete(accountingEvent).where(and(inArray(accountingEvent.AccountingEventID, c), ne(accountingEvent.PostStatus, "POSTED"))).run();
      }
      // Chỉ bổ sung dữ liệu truy vết cho event POSTED cũ, nội dung bút toán không đổi → không đổi ModifiedDate
      for (const { id, ItemCodes } of plan.healItemCodes) {
        tx.update(accountingEvent)
          .set({ ItemCodes })
          .where(and(eq(accountingEvent.AccountingEventID, id), eq(accountingEvent.PostStatus, "POSTED"), isNull(accountingEvent.ItemCodes)))
          .run();
      }

      for (const [rawOrderId, s] of result.rawStatus) {
        tx.update(rawOrders)
          .set({ BuildStatus: s.status, BuildMessage: s.message, ComCode: s.comCode })
          .where(eq(rawOrders.RawOrderID, rawOrderId))
          .run();
      }

      deleteExceptionsByKeys(tx, "BUILD", exceptionKeys);
      insertExceptions(tx, "BUILD", batch.BuildBatchID, [...result.exceptions, ...plan.exceptions]);
      return plan;
    });

    // Bộ đếm chỉ gán sau khi transaction commit (lỗi giữa chừng → rollback, không báo số ảo)
    summary.EventsCreated = plan.insert.length;
    summary.EventsReplaced = plan.replace.length;
    summary.EventsUnchangedPosted = plan.unchangedPosted;
    summary.EventsRemoved = plan.remove.length;
    summary.EventsBlocked = plan.blocked;
    summary.Exceptions = result.exceptions.length + plan.exceptions.length;
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
