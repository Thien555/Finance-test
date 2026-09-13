/**
 * (2) BUILD: RawOrders → AccountingEvent (+ BuildBatch, ExceptionLog)
 *  - Event cũ cùng khóa: NEW/ERROR/SKIPPED → thay thế ; POSTED → giữ nguyên (báo nếu nguồn đã đổi)
 *  - Event cũ không còn sinh ra nữa (VD amount về 0) và chưa post → xóa
 */
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, buildBatch, rawOrders } from "@/lib/db/schema";
import { buildOrderEvents, ORDER_JOURNAL_TYPE_CODES, ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { eventKey, orderSourceId, orderTransactionId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import type { ExceptionDraft } from "@/lib/engine/types";
import {
  chunk,
  deleteExceptionsByKeys,
  describeScope,
  insertExceptions,
  loadMasterIndex,
  periodOfDateColumn,
  type Scope,
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
    let rows = db
      .select()
      .from(rawOrders)
      .where(where.length ? and(...where) : undefined)
      .all();
    if (scope.comCode) rows = rows.filter((r) => index.comCodeOfGateway(r.PaymentGatewayName) === scope.comCode);

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

    const sourceIds = [...new Set(rows.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)))];
    const extraExceptions: ExceptionDraft[] = [];

    db.transaction((tx) => {
      // Event hiện có của các order trong scope
      const existing = new Map<string, AccountingEventRow>();
      for (const c of chunk(sourceIds, 500)) {
        for (const e of tx
          .select()
          .from(accountingEvent)
          .where(and(eq(accountingEvent.DataSource, ORDERS_DATA_SOURCE), inArray(accountingEvent.SourceID, c)))
          .all()) {
          existing.set(eventKey(e), e);
        }
      }

      const producedKeys = new Set<string>();
      for (const { rawOrderIds: _raw, ...draft } of result.events) {
        const key = eventKey(draft);
        producedKeys.add(key);
        const old = existing.get(key);
        if (!old) {
          tx.insert(accountingEvent).values({ ...draft, BuildBatchID: batch.BuildBatchID, AddDate: now }).run();
          summary.EventsCreated++;
        } else if (old.PostStatus === "POSTED") {
          summary.EventsUnchangedPosted++;
          if (old.SourceHash !== draft.SourceHash) {
            extraExceptions.push({
              DataSource: ORDERS_DATA_SOURCE,
              ComCode: draft.ComCode,
              Period: draft.Period,
              Severity: "WARNING",
              ExceptionType: "POSTED_SOURCE_CHANGED",
              SourceKey: `${draft.TransactionID}|${draft.JournalTypeCode}`,
              Message: `Event ${old.AccountingEventID} đã POSTED nhưng dữ liệu nguồn/cấu hình đã đổi (Amount cũ ${old.Amount}, mới ${draft.Amount}) → Unpost rồi Build lại`,
            });
          }
        } else {
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
            .where(eq(accountingEvent.AccountingEventID, old.AccountingEventID))
            .run();
          summary.EventsReplaced++;
        }
      }

      const staleIds = [...existing.entries()]
        .filter(([key, e]) => !producedKeys.has(key) && e.PostStatus !== "POSTED")
        .map(([, e]) => e.AccountingEventID);
      for (const c of chunk(staleIds, 500)) {
        tx.delete(accountingEvent).where(and(inArray(accountingEvent.AccountingEventID, c), ne(accountingEvent.PostStatus, "POSTED"))).run();
      }
      summary.EventsRemoved = staleIds.length;

      for (const [rawOrderId, s] of result.rawStatus) {
        tx.update(rawOrders)
          .set({ BuildStatus: s.status, BuildMessage: s.message, ComCode: s.comCode })
          .where(eq(rawOrders.RawOrderID, rawOrderId))
          .run();
      }

      deleteExceptionsByKeys(tx, "BUILD", exceptionKeys);
      const allExceptions = [...result.exceptions, ...extraExceptions];
      insertExceptions(tx, "BUILD", batch.BuildBatchID, allExceptions);
      summary.Exceptions = allExceptions.length;
    });

    summary.SourceRows = result.stats.sourceRows;
    summary.FulfilledRows = result.stats.fulfilledRows;
    summary.SkippedRows = result.stats.skippedRows;
    summary.ErrorRows = result.stats.errorRows;
    summary.EventsError = result.stats.errorEvents;
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
