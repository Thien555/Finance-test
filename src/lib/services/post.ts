/**
 * (3) POST: AccountingEvent → GLTrans (+ PostingBatch, ExceptionLog)
 *  - Lấy event PostStatus = NEW (hoặc ERROR do lần post trước lỗi) trong scope
 *  - Chia Single/Bulk theo JournalType.Classify
 *  - Chốt chặn ghi sổ trùng theo item (engine findDuplicateItems): event trùng item với event khác ngày giao/công ty → ERROR, không post
 *  - Mỗi lần post 1 loại = 1 PostingBatch
 *  - Kỳ khóa sổ (guide §6.12): event thuộc (ComCode, Period) đang LOCKED không được post — bỏ qua, đếm vào
 *    `LockedEvents` + 1 exception INFO PERIOD_LOCKED mỗi nguồn × công ty × kỳ (thay bản cũ mỗi lần chạy).
 *    1 chứng từ (DocNum) luôn thuộc đúng 1 công ty × 1 kỳ (Bulk gom theo ComCode + ngày yyyyMMdd) nên lọc theo event là đủ
 */
import { and, count, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accountingEvent, glTrans, postingBatch } from "@/lib/db/schema";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import type { MasterIndex } from "@/lib/engine/masters";
import { nowIso } from "@/lib/engine/parse";
import { LockTally, lockKey, type PeriodLocks } from "@/lib/engine/period-lock";
import { type Classify, classifyOf, postEvents } from "@/lib/engine/post";
import { findDuplicateItems, type GuardEvent } from "@/lib/engine/post-guard";
import {
  chunk,
  deleteExceptionsByKeys,
  describeScope,
  insertExceptions,
  loadMasterIndex,
  loadPeriodLocks,
  lockedWhere,
  notLocked,
  replaceLockSummaries,
  type Scope,
  scopeWhere,
} from "./common";

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
  /** Event chờ post (cùng loại) bị bỏ qua vì thuộc kỳ khóa sổ */
  LockedEvents: number;
  /** Các kỳ khóa đã bỏ qua, dạng "COMCODE|YYYYMM" (sort, không trùng) */
  LockedPeriods: string[];
  ErrorMessage?: string;
}

/** Phần bị bỏ qua vì kỳ khóa của 1 loại Single/Bulk */
interface LockedPart {
  events: number;
  periods: Set<string>;
}

/** Event chờ post: NEW, hoặc ERROR do lần post trước lỗi */
const pendingWhere = (): SQL =>
  or(eq(accountingEvent.PostStatus, "NEW"), and(eq(accountingEvent.PostStatus, "ERROR"), eq(accountingEvent.ErrorStage, "POST")))!;

export function runPost(classify: Classify | "All", scope: Scope = {}): PostSummary[] {
  const db = getDb();
  const kinds: Classify[] = classify === "All" ? ["Single", "Bulk"] : [classify];
  const index = loadMasterIndex(db);
  const locks = loadPeriodLocks(db);

  // Event chờ post thuộc kỳ khóa: chỉ đếm (gom theo nguồn × JournalType × công ty × kỳ), không động vào.
  // `locked` theo từng loại đang chạy (→ PostSummary); `tally` đếm cả 2 loại để tóm tắt không đổi theo loại được chọn
  const tally = new LockTally();
  const locked = new Map<Classify, LockedPart>(kinds.map((k) => [k, { events: 0, periods: new Set<string>() }]));
  if (!locks.isEmpty) {
    const groups = db
      .select({
        DataSource: accountingEvent.DataSource,
        JournalTypeCode: accountingEvent.JournalTypeCode,
        ComCode: accountingEvent.ComCode,
        Period: accountingEvent.Period,
        n: count(),
      })
      .from(accountingEvent)
      .where(and(...scopeWhere(accountingEvent, scope), pendingWhere(), lockedWhere(locks, accountingEvent.ComCode, accountingEvent.Period)))
      .groupBy(accountingEvent.DataSource, accountingEvent.JournalTypeCode, accountingEvent.ComCode, accountingEvent.Period)
      .all();
    for (const g of groups) {
      const classify = classifyOf(index, g);
      if (!classify) continue; // JournalType không có Classify: không bao giờ post được, không phải "bỏ qua vì khóa"
      tally.add(g.DataSource, g, "events", g.n);
      const part = locked.get(classify);
      if (!part) continue; // loại không chạy lần này
      part.events += g.n;
      part.periods.add(lockKey(g.ComCode, g.Period));
    }
  }

  const out = kinds.map((k) => postOne(k, scope, index, locks, locked.get(k)!));

  // Tóm tắt phần bị bỏ qua: thay bản cũ trong phạm vi (gọi cả khi rỗng để dọn tóm tắt cũ sau khi mở khóa)
  db.transaction((tx) => {
    replaceLockSummaries(tx, "POST", scope.dataSource ? [scope.dataSource.toUpperCase()] : null, scope, tally.toExceptions("Post"), null);
  });
  return out;
}

function postOne(classify: Classify, scope: Scope, index: MasterIndex, locks: PeriodLocks, locked: LockedPart): PostSummary {
  const db = getDb();

  const candidates = db
    .select()
    .from(accountingEvent)
    .where(and(...scopeWhere(accountingEvent, scope), pendingWhere(), ...notLocked(locks, accountingEvent.ComCode, accountingEvent.Period)))
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
    LockedEvents: locked.events,
    LockedPeriods: [...locked.periods].sort(),
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
    // Mọi event cùng DataSource + OrderID (mọi PostStatus, mọi scope, cả kỳ khóa) để kiểm tra item đã/đang chờ ghi sổ dưới khóa khác
    const orderIdsBySource = new Map<string, Set<string>>();
    for (const e of candidates) {
      if (e.OrderID) orderIdsBySource.set(e.DataSource, (orderIdsBySource.get(e.DataSource) ?? new Set()).add(e.OrderID));
    }
    const orderEvents: GuardEvent[] = [];
    for (const [dataSource, ids] of orderIdsBySource) {
      for (const c of chunk([...ids], 500)) {
        orderEvents.push(
          ...db
            .select({
              AccountingEventID: accountingEvent.AccountingEventID,
              DataSource: accountingEvent.DataSource,
              ComCode: accountingEvent.ComCode,
              TransactionID: accountingEvent.TransactionID,
              SourceID: accountingEvent.SourceID,
              OrderID: accountingEvent.OrderID,
              ItemCodes: accountingEvent.ItemCodes,
              PostStatus: accountingEvent.PostStatus,
              ErrorStage: accountingEvent.ErrorStage,
              PostedDocNum: accountingEvent.PostedDocNum,
            })
            .from(accountingEvent)
            .where(and(eq(accountingEvent.DataSource, dataSource), inArray(accountingEvent.OrderID, c)))
            .all(),
        );
      }
    }
    const duplicates = findDuplicateItems(candidates, orderEvents, [ORDERS_DATA_SOURCE]);

    const result = postEvents(
      candidates.filter((e) => !duplicates.has(e.AccountingEventID)),
      classify,
      index,
    );
    for (const e of candidates) {
      const message = duplicates.get(e.AccountingEventID);
      if (!message) continue;
      result.failed.push({ AccountingEventID: e.AccountingEventID, ErrorMessage: message });
      result.exceptions.push({
        DataSource: e.DataSource,
        ComCode: e.ComCode,
        Period: e.Period,
        Severity: "ERROR",
        ExceptionType: "DUPLICATE_ITEM",
        SourceKey: `EventID ${e.AccountingEventID} | ${e.TransactionID}`,
        Message: message,
      });
    }
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

      // Candidate đều ở kỳ mở; `locks` giữ lại exception cũ cùng SourceKey nếu nó còn gắn kỳ khóa
      deleteExceptionsByKeys(
        tx,
        "POST",
        candidates.map((e) => `EventID ${e.AccountingEventID} | ${e.TransactionID}`),
        locks,
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
