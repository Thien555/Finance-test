/**
 * (2) BUILD các nguồn ngoài Orders: RawPaypal / RawStripe / RawPipo / RawAccountingSource → AccountingEvent.
 *
 * Khác Orders ở chỗ 1 dòng raw ⇄ 1 bộ event (khóa `SourceID` ổn định), không có khái niệm "build trọn đơn":
 *  - Draft = mọi dòng raw trong phạm vi (ComCode + kỳ theo `PostingDate`)
 *  - Event đối chiếu = event cùng DataSource trong phạm vi, hợp với event có `SourceID` của draft
 *  - Không truyền `deadSourceIds`: dòng biến mất khỏi file chỉ sinh cảnh báo POSTED_SOURCE_CHANGED,
 *    còn việc sửa nội dung dòng đã build/post đã bị chặn từ tầng Import
 */
import { and, count, eq, gte, inArray, lte, ne, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "@/lib/db/client";
import {
  type AccountingEventRow,
  accountingEvent,
  buildBatch,
  rawAccountingSource,
  rawPaypal,
  rawPipo,
  rawStripe,
} from "@/lib/db/schema";
import { type BankSourceSpec, buildBankEvents } from "@/lib/engine/build-bank";
import { bankSourceId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { reconcileEvents } from "@/lib/engine/reconcile-events";
import { accountingSourceSpec } from "@/lib/engine/sources/accounting-source";
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
  type Scope,
  scopeWhere,
} from "./common";

/** Bảng raw + cách đọc/ghi trạng thái build, gắn với spec engine của nguồn */
interface SourceBuilder<R> {
  spec: BankSourceSpec<R>;
  loadRows(db: DbOrTx, scope: Scope): R[];
  setStatus(tx: DbOrTx, rowId: number, status: string, message: string | null, comCode: string | null): void;
  resetAll(tx: DbOrTx, scope: Scope): void;
  countBuilt(db: DbOrTx, scope: Scope): number;
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
    resetAll: (tx, scope) => {
      const w = periodWhere(rawPaypal, scope);
      tx.update(rawPaypal)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope) =>
      db
        .select({ n: count() })
        .from(rawPaypal)
        .where(and(ne(rawPaypal.BuildStatus, "NOT_BUILT"), ...periodWhere(rawPaypal, scope)))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawPaypal.$inferSelect>,
  stripe: {
    spec: stripeSpec,
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
    resetAll: (tx, scope) => {
      const w = periodWhere(rawStripe, scope);
      tx.update(rawStripe)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope) =>
      db
        .select({ n: count() })
        .from(rawStripe)
        .where(and(ne(rawStripe.BuildStatus, "NOT_BUILT"), ...periodWhere(rawStripe, scope)))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawStripe.$inferSelect>,
  pipo: {
    spec: pipoSpec,
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
    resetAll: (tx, scope) => {
      const w = periodWhere(rawPipo, scope);
      tx.update(rawPipo)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope) =>
      db
        .select({ n: count() })
        .from(rawPipo)
        .where(and(ne(rawPipo.BuildStatus, "NOT_BUILT"), ...periodWhere(rawPipo, scope)))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawPipo.$inferSelect>,
  "accounting-source": {
    spec: accountingSourceSpec,
    loadRows: (db, scope) => {
      const w = periodWhere(rawAccountingSource, scope);
      return db
        .select()
        .from(rawAccountingSource)
        .where(w.length ? and(...w) : undefined)
        .all();
    },
    setStatus: (tx, id, status, message, comCode) =>
      tx
        .update(rawAccountingSource)
        .set({ BuildStatus: status, BuildMessage: message, ComCode: comCode })
        .where(eq(rawAccountingSource.RawAccountingSourceID, id))
        .run(),
    resetAll: (tx, scope) => {
      const w = periodWhere(rawAccountingSource, scope);
      tx
        .update(rawAccountingSource)
        .set({ BuildStatus: "NOT_BUILT", BuildMessage: null })
        .where(w.length ? and(...w) : undefined)
        .run();
    },
    countBuilt: (db, scope) =>
      db
        .select({ n: count() })
        .from(rawAccountingSource)
        .where(and(ne(rawAccountingSource.BuildStatus, "NOT_BUILT"), ...periodWhere(rawAccountingSource, scope)))
        .all()[0].n,
  } satisfies SourceBuilder<typeof rawAccountingSource.$inferSelect>,
};

/** Mỗi entry đã được `satisfies SourceBuilder<Row>` kiểm ở trên; chỗ dùng chung chỉ cần hình dạng chung */
const builderOf = (source: SourceKey): SourceBuilder<unknown> => builders[source] as unknown as SourceBuilder<unknown>;

export const SOURCE_DATA_SOURCES: Record<SourceKey, string> = {
  paypal: paypalSpec.dataSource,
  stripe: stripeSpec.dataSource,
  pipo: pipoSpec.dataSource,
  "accounting-source": accountingSourceSpec.dataSource,
};

/** Reset BuildStatus của bảng raw theo nguồn — dùng khi Unbuild */
export function resetSourceRawStatus(tx: DbOrTx, source: SourceKey, scope: Scope) {
  builderOf(source).resetAll(tx, scope);
}

/** Số dòng raw đã build (BuildStatus ≠ NOT_BUILT) trong phạm vi — dùng cho preview Unbuild */
export function countBuiltSourceRows(db: DbOrTx, source: SourceKey, scope: Scope): number {
  return builderOf(source).countBuilt(db, scope);
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
  };

  try {
    const index = loadMasterIndex(db);
    const rows = builder.loadRows(db, scope);
    const result = buildBankEvents(rows, spec, index);
    const now = nowIso();

    const draftSourceIds = new Set(rows.map((r) => bankSourceId(spec.dataSource, spec.sourceKey(r))));

    const plan = db.transaction((tx) => {
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

      const plan = reconcileEvents({ drafts: result.events, existing: [...byId.values()] });

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
          .where(and(eq(accountingEvent.AccountingEventID, id), ne(accountingEvent.PostStatus, "POSTED")))
          .run();
      }
      for (const c of chunk(plan.remove, 500)) {
        tx.delete(accountingEvent).where(and(inArray(accountingEvent.AccountingEventID, c), ne(accountingEvent.PostStatus, "POSTED"))).run();
      }

      for (const [rowId, s] of result.rawStatus) {
        builder.setStatus(tx, rowId, s.status, s.message, s.comCode);
      }

      deleteExceptionsByDataSource(tx, "BUILD", spec.dataSource, scope);
      insertExceptions(tx, "BUILD", batch.BuildBatchID, [...result.exceptions, ...plan.exceptions]);
      return plan;
    });

    summary.EventsCreated = plan.insert.length;
    summary.EventsReplaced = plan.replace.length;
    summary.EventsUnchangedPosted = plan.unchangedPosted;
    summary.EventsRemoved = plan.remove.length;
    summary.EventsBlocked = plan.blocked;
    summary.Exceptions = result.exceptions.length + plan.exceptions.length;
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
