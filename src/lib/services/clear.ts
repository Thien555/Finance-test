/**
 * Điều chỉnh vận hành (tài liệu §15):
 *  - Unpost          : xóa GLTrans, event POSTED → NEW
 *  - Unbuild         : xóa AccountingEvent chưa post, RawOrders → NOT_BUILT
 *  - Unpost + Unbuild: làm lần lượt 2 bước trên
 * Mọi hàm hỗ trợ preview (chỉ đếm, không sửa dữ liệu).
 */
import { and, count, eq, gte, inArray, isNull, lte, ne, not, notInArray, or, type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accountingEvent, exceptionLog, glTrans, postingBatch, rawOrders } from "@/lib/db/schema";
import { nowIso } from "@/lib/engine/parse";
import { chunk, periodOfDateColumn, type Scope, scopeWhere } from "./common";

export interface UnpostResult {
  preview: boolean;
  events: number;
  glLines: number;
  documents: number;
  batches: number[];
}

export function unpost(options: { scope?: Scope; postBatchId?: number | null; preview?: boolean }): UnpostResult {
  const db = getDb();
  const scope = options.scope ?? {};
  const where: SQL[] = [eq(accountingEvent.PostStatus, "POSTED"), ...scopeWhere(accountingEvent, scope)];
  if (options.postBatchId) where.push(eq(accountingEvent.PostBatchID, options.postBatchId));

  const docNums = [
    ...new Set(
      db
        .selectDistinct({ doc: accountingEvent.PostedDocNum })
        .from(accountingEvent)
        .where(and(...where))
        .all()
        .map((r) => r.doc)
        .filter((d): d is string => !!d),
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

  const result: UnpostResult = { preview: !!options.preview, events, glLines, documents: docNums.length, batches: [...batches] };
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
    // Batch không còn dòng GL nào → đánh dấu UNPOSTED
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
}

export function unbuild(options: { scope?: Scope; includePosted?: boolean; preview?: boolean }): UnbuildResult {
  const db = getDb();
  const scope = options.scope ?? {};

  const unposted = options.includePosted ? unpost({ scope, preview: options.preview }) : null;
  // Preview của "Unpost + Unbuild": event POSTED trong scope coi như sẽ được unpost trước
  const simulateUnpost = !!options.preview && !!unposted;

  const eventScope = scopeWhere(accountingEvent, scope);
  const countEvents = (...extra: SQL[]) =>
    db.select({ n: count() }).from(accountingEvent).where(and(...eventScope, ...extra)).all()[0].n;
  const deletable = countEvents(ne(accountingEvent.PostStatus, "POSTED"));
  const postedInScope = countEvents(eq(accountingEvent.PostStatus, "POSTED"));

  // Order còn event POSTED (ngoài phần sẽ bị unpost) thì raw giữ nguyên BUILT
  const postedWhere: SQL[] = [eq(accountingEvent.PostStatus, "POSTED")];
  if (simulateUnpost) postedWhere.push(not(and(...eventScope) ?? sql`1`));
  const keepOrders = db
    .selectDistinct({ id: accountingEvent.OrderID })
    .from(accountingEvent)
    .where(and(...postedWhere))
    .all()
    .map((r) => r.id)
    .filter((x): x is string => !!x);

  const rawWhere: SQL[] = [ne(rawOrders.BuildStatus, "NOT_BUILT")];
  if (scope.comCode) rawWhere.push(or(eq(rawOrders.ComCode, scope.comCode), isNull(rawOrders.ComCode))!);
  if (scope.periodFrom) rawWhere.push(gte(periodOfDateColumn(rawOrders.FulfilledAt), scope.periodFrom));
  if (scope.periodTo) rawWhere.push(lte(periodOfDateColumn(rawOrders.FulfilledAt), scope.periodTo));
  const rawCondition = and(...rawWhere, ...chunk(keepOrders, 500).map((c) => notInArray(rawOrders.OrderId, c)));
  const [{ n: rawRows }] = db.select({ n: count() }).from(rawOrders).where(rawCondition).all();

  const result: UnbuildResult = {
    preview: !!options.preview,
    unposted,
    deletedEvents: simulateUnpost ? deletable + postedInScope : deletable,
    postedEventsKept: simulateUnpost ? 0 : postedInScope,
    rawRowsReset: rawRows,
  };
  if (options.preview) return result;

  db.transaction((tx) => {
    tx.delete(accountingEvent).where(and(...eventScope, ne(accountingEvent.PostStatus, "POSTED"))).run();
    tx.update(rawOrders).set({ BuildStatus: "NOT_BUILT", BuildMessage: null }).where(rawCondition).run();

    const exWhere: SQL[] = [eq(exceptionLog.BatchType, "BUILD")];
    if (scope.comCode) exWhere.push(eq(exceptionLog.ComCode, scope.comCode));
    if (scope.periodFrom) exWhere.push(gte(exceptionLog.Period, scope.periodFrom));
    if (scope.periodTo) exWhere.push(lte(exceptionLog.Period, scope.periodTo));
    tx.delete(exceptionLog).where(and(...exWhere)).run();
  });
  return result;
}

/** Xóa toàn bộ dữ liệu test (giữ master data) */
export function resetTransactionalData() {
  const sqlite = getDb().$client;
  const tables = ["GLTrans", "AccountingEvent", "PostingBatch", "BuildBatch", "ExceptionLog", "RawOrders", "ImportBatch"];
  sqlite.transaction(() => {
    for (const t of tables) sqlite.prepare(`DELETE FROM "${t}"`).run();
    const placeholders = tables.map(() => "?").join(",");
    sqlite.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...tables);
  })();
}
