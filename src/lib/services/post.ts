/**
 * (3) POST: AccountingEvent → GLTrans (+ PostingBatch, ExceptionLog)
 *  - Lấy event PostStatus = NEW (hoặc ERROR do lần post trước lỗi) trong scope
 *  - Chia Single/Bulk theo JournalType.Classify
 *  - Mỗi lần post 1 loại = 1 PostingBatch
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accountingEvent, glTrans, postingBatch } from "@/lib/db/schema";
import { nowIso } from "@/lib/engine/parse";
import { type Classify, classifyOf, postEvents } from "@/lib/engine/post";
import { chunk, deleteExceptionsByKeys, describeScope, insertExceptions, loadMasterIndex, type Scope, scopeWhere } from "./common";

export interface PostSummary {
  Classify: Classify;
  PostBatchID: number | null;
  Status: "SUCCESS" | "FAILED" | "NOTHING_TO_POST";
  scope: string;
  CandidateEvents: number;
  PostedEvents: number;
  ErrorEvents: number;
  SkippedEvents: number;
  Documents: number;
  InsertedRows: number;
  ErrorMessage?: string;
}

export function runPost(classify: Classify | "All", scope: Scope = {}): PostSummary[] {
  const kinds: Classify[] = classify === "All" ? ["Single", "Bulk"] : [classify];
  return kinds.map((k) => postOne(k, scope));
}

function postOne(classify: Classify, scope: Scope): PostSummary {
  const db = getDb();
  const index = loadMasterIndex(db);

  const candidates = db
    .select()
    .from(accountingEvent)
    .where(
      and(
        ...scopeWhere(accountingEvent, scope),
        or(eq(accountingEvent.PostStatus, "NEW"), and(eq(accountingEvent.PostStatus, "ERROR"), eq(accountingEvent.ErrorStage, "POST"))),
      ),
    )
    .all()
    .filter((e) => classifyOf(index, e) === classify);

  const summary: PostSummary = {
    Classify: classify,
    PostBatchID: null,
    Status: "SUCCESS",
    scope: describeScope(scope),
    CandidateEvents: candidates.length,
    PostedEvents: 0,
    ErrorEvents: 0,
    SkippedEvents: 0,
    Documents: 0,
    InsertedRows: 0,
  };
  if (candidates.length === 0) {
    summary.Status = "NOTHING_TO_POST";
    return summary;
  }

  const periods = candidates.map((e) => e.Period).sort();
  const startedAt = nowIso();
  const [batch] = db
    .insert(postingBatch)
    .values({
      DataSource: scope.dataSource?.toUpperCase() ?? null,
      Classify: classify,
      JournalTypeCode: null,
      ComCodeList: scope.comCode ?? [...new Set(candidates.map((e) => e.ComCode))].join(","),
      PeriodFrom: scope.periodFrom ?? periods[0],
      PeriodTo: scope.periodTo ?? periods[periods.length - 1],
      StartedAt: startedAt,
      Status: "RUNNING",
      AddDate: startedAt,
    })
    .returning()
    .all();
  summary.PostBatchID = batch.PostBatchID;

  try {
    const result = postEvents(candidates, classify, index);
    const now = nowIso();

    db.transaction((tx) => {
      for (const c of chunk(result.glLines, 200)) {
        tx.insert(glTrans)
          .values(c.map((l) => ({ ...l, PostBatchID: batch.PostBatchID, AddDate: now })))
          .run();
      }

      // Cập nhật event POSTED, gom theo chứng từ để giảm số câu lệnh
      const byDoc = new Map<string, { key: string | null; ids: number[] }>();
      for (const p of result.posted) {
        const doc = byDoc.get(p.PostedDocNum) ?? { key: p.PostingGroupKey, ids: [] };
        doc.ids.push(p.AccountingEventID);
        byDoc.set(p.PostedDocNum, doc);
      }
      for (const [docNum, { key, ids }] of byDoc) {
        for (const c of chunk(ids, 500)) {
          tx.update(accountingEvent)
            .set({
              PostStatus: "POSTED",
              PostedDocNum: docNum,
              PostingGroupKey: key,
              PostBatchID: batch.PostBatchID,
              PostedAt: now,
              ErrorStage: null,
              ErrorMessage: null,
              ModifiedDate: now,
            })
            .where(inArray(accountingEvent.AccountingEventID, c))
            .run();
        }
      }
      for (const f of result.failed) {
        tx.update(accountingEvent)
          .set({ PostStatus: "ERROR", ErrorStage: "POST", ErrorMessage: f.ErrorMessage, ModifiedDate: now })
          .where(eq(accountingEvent.AccountingEventID, f.AccountingEventID))
          .run();
      }
      for (const s of result.skipped) {
        tx.update(accountingEvent)
          .set({ PostStatus: "SKIPPED", ErrorStage: "POST", ErrorMessage: s.ErrorMessage, ModifiedDate: now })
          .where(eq(accountingEvent.AccountingEventID, s.AccountingEventID))
          .run();
      }

      deleteExceptionsByKeys(
        tx,
        "POST",
        candidates.map((e) => `EventID ${e.AccountingEventID} | ${e.TransactionID}`),
      );
      insertExceptions(tx, "POST", batch.PostBatchID, result.exceptions);

      tx.update(postingBatch)
        .set({
          EndedAt: nowIso(),
          Status: "SUCCESS",
          InsertedRows: result.glLines.length,
          PostedEvents: result.posted.length,
          ErrorEvents: result.failed.length,
          SkippedEvents: result.skipped.length,
          ErrorMessage: result.failed.length ? `${result.failed.length} event lỗi, xem Exceptions` : null,
          ModifiedDate: nowIso(),
        })
        .where(eq(postingBatch.PostBatchID, batch.PostBatchID))
        .run();
    });

    summary.PostedEvents = result.posted.length;
    summary.ErrorEvents = result.failed.length;
    summary.SkippedEvents = result.skipped.length;
    summary.Documents = result.docCount;
    summary.InsertedRows = result.glLines.length;
  } catch (err) {
    summary.Status = "FAILED";
    summary.ErrorMessage = err instanceof Error ? err.message : String(err);
    db.update(postingBatch)
      .set({ EndedAt: nowIso(), Status: "FAILED", ErrorMessage: summary.ErrorMessage, ModifiedDate: nowIso() })
      .where(eq(postingBatch.PostBatchID, batch.PostBatchID))
      .run();
  }
  return summary;
}
