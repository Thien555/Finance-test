/**
 * (2) BUILD các nguồn ngoài Orders: RawPaypal / RawStripe / RawPipo → AccountingEvent.
 *
 * Khác Orders ở chỗ 1 dòng raw ⇄ 1 bộ event (khóa `SourceID` ổn định), không có khái niệm "build trọn đơn":
 *  - Draft = mọi dòng raw trong phạm vi (ComCode + kỳ theo `PostingDate`)
 *  - Event đối chiếu = event cùng DataSource trong phạm vi, hợp với event có `SourceID` của draft
 *  - Không truyền `deadSourceIds`: dòng biến mất khỏi file chỉ sinh cảnh báo POSTED_SOURCE_CHANGED,
 *    còn việc sửa nội dung dòng đã build/post đã bị chặn từ tầng Import (dòng còn event giữ BUILT kể cả sau Unbuild)
 *  - `oneEventSetPerSource`: event đã ghi sổ của dòng mà không còn sinh ra chặn draft mới của dòng dù khác nghiệp vụ
 *    (dòng bị phân loại lại sau khi Post — chốt thứ 2 sau Import)
 *  - Kỳ đã khóa sổ (guide §6.12): như Orders — engine chạy trên mọi dòng (exception gom nhóm giữ nguyên), reconcileEvents bỏ
 *    qua draft/event thuộc kỳ khóa, SQL thay/xóa thêm `notLocked`; dòng raw có (ComCode, kỳ PostingDate) khóa giữ BuildStatus cũ
 */
import { and, count, eq, gte, inArray, lte, ne, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, buildBatch, rawPaypal, rawPipo, rawStripe } from "@/lib/db/schema";
import { type BankSourceSpec, buildBankEvents } from "@/lib/engine/build-bank";
import { bankSourceId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { firstLocked, LockTally, lockKey, PeriodLocks, type PeriodRef, periodOfDate } from "@/lib/engine/period-lock";
import { reconcileEvents } from "@/lib/engine/reconcile-events";
import { paypalSpec } from "@/lib/engine/sources/paypal";
import { pipoSpec } from "@/lib/engine/sources/pipo";
import { stripeSpec } from "@/lib/engine/sources/stripe";
import type { SourceKey } from "@/lib/sources/columns";
import type { BuildSummary } from "./build";
import {
  chunk,
  deleteExceptionsByDataSource,
  describeScope,
  type DbOrTx,
  insertExceptions,
  loadMasterIndex,
  loadPeriodLocks,
  lockedWhere,
  notLocked,
  periodOfDateColumn,
  replaceLockSummaries,
  type Scope,
  scopeWhere,
} from "./common";

/** Cột chung của các bảng raw ngân hàng — lọc kỳ và khóa sổ dựa trên chúng */
interface RawBankRow {
  ComCode: string | null;
  PostingDate: string | null;
}

/** Bảng raw + cách đọc/ghi trạng thái build, gắn với spec engine của nguồn */
interface SourceBuilder<R extends RawBankRow> {
  spec: BankSourceSpec<R>;
  /**
   * Cột ComCode + PostingDate + SourceKey của bảng raw: điều kiện kỳ khóa và "dòng không còn event" ở
   * `resetSourceRawStatus` / `countBuiltSourceRows`
   */
  columns: { ComCode: SQLiteColumn; PostingDate: SQLiteColumn; SourceKey: SQLiteColumn };
  loadRows(db: DbOrTx, scope: Scope): R[];
  setStatus(tx: DbOrTx, rowId: number, status: string, message: string | null, comCode: string | null): void;
  /** `extra`: điều kiện thêm (kỳ khóa); rỗng → SQL như trước khi có khóa sổ */
  resetAll(tx: DbOrTx, scope: Scope, extra: SQL[]): void;
  countBuilt(db: DbOrTx, scope: Scope, extra: SQL[]): number;
}

function periodWhere(column: { PostingDate: SQLiteColumn; ComCode: SQLiteColumn }, scope: Scope): SQL[] {
  const where: SQL[] = [];
  if (scope.comCode) where.push(eq(column.ComCode, scope.comCode));
  // PostingDate đã chuẩn hóa YYYY-MM-DD nên so kỳ bằng cách cắt chuỗi giống periodOfDateColumn
  if (scope.periodFrom) where.push(gte(column.PostingDate, `${scope.periodFrom.slice(0, 4)}-${scope.periodFrom.slice(4, 6)}-01`));
  if (scope.periodTo) where.push(lte(column.PostingDate, `${scope.periodTo.slice(0, 4)}-${scope.periodTo.slice(4, 6)}-31`));
  return where;
}

const builders = {
  paypal: {
    spec: paypalSpec,
    columns: rawPaypal,
    loadRows: (db, scope) => {
      const w = periodWhere(rawPaypal, scope);
      return db
        .select()
        .from(rawPaypal)
        .where(w.length ? and(...w) : undefined)
        .all();
    },
    setStatus: (tx, id, status, message, comCode) =>
      tx.update(rawPaypal).set({ BuildStatus: status, BuildMessage: message, ComCode: comCode }).where(eq(rawPaypal.RawPaypalID, id)).run(),
    resetAll: (tx, scope, extra) => {
      const w = [...periodWhere(rawPaypal, scope), ...extra];
      tx.update(rawPaypal)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope, extra) =>
      db
        .select({ n: count() })
        .from(rawPaypal)
        .where(and(ne(rawPaypal.BuildStatus, "NOT_BUILT"), ...periodWhere(rawPaypal, scope), ...extra))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawPaypal.$inferSelect>,
  stripe: {
    spec: stripeSpec,
    columns: rawStripe,
    loadRows: (db, scope) => {
      const w = periodWhere(rawStripe, scope);
      return db
        .select()
        .from(rawStripe)
        .where(w.length ? and(...w) : undefined)
        .all();
    },
    setStatus: (tx, id, status, message, comCode) =>
      tx.update(rawStripe).set({ BuildStatus: status, BuildMessage: message, ComCode: comCode }).where(eq(rawStripe.RawStripeID, id)).run(),
    resetAll: (tx, scope, extra) => {
      const w = [...periodWhere(rawStripe, scope), ...extra];
      tx.update(rawStripe)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope, extra) =>
      db
        .select({ n: count() })
        .from(rawStripe)
        .where(and(ne(rawStripe.BuildStatus, "NOT_BUILT"), ...periodWhere(rawStripe, scope), ...extra))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawStripe.$inferSelect>,
  pipo: {
    spec: pipoSpec,
    columns: rawPipo,
    loadRows: (db, scope) => {
      const w = periodWhere(rawPipo, scope);
      return db
        .select()
        .from(rawPipo)
        .where(w.length ? and(...w) : undefined)
        .all();
    },
    setStatus: (tx, id, status, message, comCode) =>
      tx.update(rawPipo).set({ BuildStatus: status, BuildMessage: message, ComCode: comCode }).where(eq(rawPipo.RawPipoID, id)).run(),
    resetAll: (tx, scope, extra) => {
      const w = [...periodWhere(rawPipo, scope), ...extra];
      tx.update(rawPipo)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope, extra) =>
      db
        .select({ n: count() })
        .from(rawPipo)
        .where(and(ne(rawPipo.BuildStatus, "NOT_BUILT"), ...periodWhere(rawPipo, scope), ...extra))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawPipo.$inferSelect>,
};

/** Mỗi entry đã được `satisfies SourceBuilder<Row>` kiểm ở trên; chỗ dùng chung chỉ cần hình dạng chung */
const builderOf = (source: SourceKey): SourceBuilder<RawBankRow> => builders[source] as unknown as SourceBuilder<RawBankRow>;

export const SOURCE_DATA_SOURCES: Record<SourceKey, string> = {
  paypal: paypalSpec.dataSource,
  stripe: stripeSpec.dataSource,
  pipo: pipoSpec.dataSource,
};

/** Kỳ của dòng raw ngân hàng = kỳ PostingDate (cùng quy tắc với `periodWhere` và event) */
const rawPeriod = (b: SourceBuilder<RawBankRow>) => periodOfDateColumn(b.columns.PostingDate);

/**
 * (ComCode, kỳ) của 1 dòng raw: theo cột đã lưu (khớp điều kiện SQL của `resetSourceRawStatus` / `countBuiltSourceRows`)
 * và theo spec (ComCode / ngày ghi sổ mà Build ghi lên event)
 */
function rawRowRefs(spec: BankSourceSpec<RawBankRow>, row: RawBankRow): PeriodRef[] {
  return [
    { ComCode: row.ComCode, Period: periodOfDate(row.PostingDate) },
    { ComCode: spec.comCode(row), Period: periodOfDate(spec.postingDate(row)) },
  ];
}

/**
 * Dòng raw không còn event nào của nó (SourceID = `{DataSource}|{SourceKey}`) thỏa `survives`. Unbuild chỉ đưa những dòng này
 * về NOT_BUILT: dòng còn event (POSTED được giữ, kỳ khóa, ngoài phạm vi) phải giữ BUILT để Import vẫn chặn sửa dòng
 * (§6.11.6) — reset cả dòng còn event POSTED là bug cũ §13.3 #21: sửa tay JournalType rồi import + Build + Post → ghi sổ trùng.
 * `survives`: điều kiện trên AccountingEvent của event còn lại sau Unbuild. Mặc định mọi event trong DB (gọi sau khi đã xóa);
 * preview truyền điều kiện mô phỏng phần sắp xóa.
 */
function withoutEvents(b: SourceBuilder<RawBankRow>, survives: SQL): SQL {
  const ds = b.spec.dataSource;
  return sql`NOT EXISTS (SELECT 1 FROM ${accountingEvent} WHERE ${accountingEvent.DataSource} = ${ds}
    AND ${accountingEvent.SourceID} = ${ds} || '|' || ${b.columns.SourceKey} AND ${survives})`;
}

/**
 * Reset BuildStatus của bảng raw theo nguồn — dùng khi Unbuild, SAU khi đã xóa event. Chỉ dòng không còn event nào;
 * dòng thuộc kỳ khóa (`locks`) giữ nguyên
 */
export function resetSourceRawStatus(tx: DbOrTx, source: SourceKey, scope: Scope, locks = PeriodLocks.NONE) {
  const b = builderOf(source);
  b.resetAll(tx, scope, [...notLocked(locks, b.columns.ComCode, rawPeriod(b)), withoutEvents(b, sql`1 = 1`)]);
}

/**
 * Số dòng raw đã build (BuildStatus ≠ NOT_BUILT) trong phạm vi, không thuộc kỳ khóa, sẽ được Unbuild đưa về NOT_BUILT
 * (không còn event nào thỏa `survives` sau khi xóa) — dùng cho preview Unbuild
 */
export function countBuiltSourceRows(db: DbOrTx, source: SourceKey, scope: Scope, locks = PeriodLocks.NONE, survives: SQL = sql`1 = 1`): number {
  const b = builderOf(source);
  return b.countBuilt(db, scope, [...notLocked(locks, b.columns.ComCode, rawPeriod(b)), withoutEvents(b, survives)]);
}

/** Số dòng raw đã build trong phạm vi mà (ComCode, kỳ PostingDate) thuộc kỳ khóa — Unbuild giữ nguyên, báo số lượng */
export function countLockedSourceRows(db: DbOrTx, source: SourceKey, scope: Scope, locks: PeriodLocks): number {
  if (locks.isEmpty) return 0;
  const b = builderOf(source);
  return b.countBuilt(db, scope, [lockedWhere(locks, b.columns.ComCode, rawPeriod(b))]);
}

export function runBuildSource(source: SourceKey, scope: Scope = {}): BuildSummary {
  const builder = builderOf(source);
  const spec = builder.spec;
  const db = getDb();
  const [batch] = db
    .insert(buildBatch)
    .values({
      DataSource: spec.dataSource,
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
    const rows = builder.loadRows(db, scope);
    const result = buildBankEvents(rows, spec, index);
    const now = nowIso();

    const draftSourceIds = new Set(rows.map((r) => bankSourceId(spec.dataSource, spec.sourceKey(r))));

    const built = db.transaction((tx) => {
      // Kỳ khóa đọc trong transaction, dùng cho mọi bước ghi bên dưới
      const locks = loadPeriodLocks(tx);
      const tally = new LockTally();

      // Event đối chiếu: trong phạm vi build, hoặc có SourceID của dòng raw đang build (kể cả khi
      // dòng đã đổi kỳ/ComCode nên rơi ra ngoài phạm vi)
      const byId = new Map<number, AccountingEventRow>();
      for (const e of tx
        .select()
        .from(accountingEvent)
        .where(and(eq(accountingEvent.DataSource, spec.dataSource), ...scopeWhere(accountingEvent, scope)))
        .all()) {
        byId.set(e.AccountingEventID, e);
      }
      if (scope.comCode || scope.periodFrom || scope.periodTo) {
        for (const c of chunk([...draftSourceIds], 500)) {
          for (const e of tx
            .select()
            .from(accountingEvent)
            .where(and(eq(accountingEvent.DataSource, spec.dataSource), inArray(accountingEvent.SourceID, c)))
            .all()) {
            byId.set(e.AccountingEventID, e);
          }
        }
      }

      const existing = [...byId.values()];
      // 1 dòng raw ⇄ 1 bộ event: event đã ghi sổ của dòng mà không còn sinh ra chặn bản mới dù khác nghiệp vụ (guide §6.11.6)
      const plan = reconcileEvents({ drafts: result.events, existing, isLocked: (x) => locks.isLocked(x), oneEventSetPerSource: true });
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

      // Dòng raw thuộc kỳ khóa giữ nguyên BuildStatus. Dòng kỳ mở mà event cùng khóa ở kỳ khóa (EVENT_LOCKED) vẫn nhận
      // trạng thái engine trả về — event không ghi, đã có exception ERROR PERIOD_LOCKED
      const rowById = new Map(rows.map((r) => [spec.rowId(r), r]));
      let lockedRows = 0;
      for (const [rowId, s] of result.rawStatus) {
        const row = rowById.get(rowId);
        const lockedRef = row && firstLocked(locks, rawRowRefs(spec, row));
        if (lockedRef) {
          lockedRows++;
          tally.add(spec.dataSource, lockedRef, "rows");
          continue;
        }
        builder.setStatus(tx, rowId, s.status, s.message, s.comCode);
      }
      for (const l of plan.locked) if (l.reason === "DRAFT_LOCKED") tally.add(spec.dataSource, l.draft, "events");

      // Exception engine gom nhóm có Period = null → không thuộc kỳ nào, ghi như cũ. Exception cũ thuộc kỳ khóa giữ nguyên
      const exceptions = [...result.exceptions, ...plan.exceptions.filter((e) => !locks.isLocked(e))];
      const lockSummaries = tally.toExceptions("Build");
      deleteExceptionsByDataSource(tx, "BUILD", spec.dataSource, scope, locks);
      insertExceptions(tx, "BUILD", batch.BuildBatchID, exceptions);
      replaceLockSummaries(tx, "BUILD", [spec.dataSource], scope, lockSummaries, batch.BuildBatchID);

      // Kỳ khóa đã bỏ qua: draft / dòng raw đã đếm + event cũ thuộc kỳ khóa lẽ ra bị thay / xóa / cảnh báo
      const lockedPeriods = new Set(tally.periods);
      for (const e of existing) if (locks.isLocked(e)) lockedPeriods.add(lockKey(e.ComCode, e.Period));
      return { plan, lockedRows, exceptionCount: exceptions.length + lockSummaries.length, lockedPeriods: [...lockedPeriods].sort() };
    });
    const { plan } = built;

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
    summary.FulfilledRows = result.stats.acceptedRows;
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
