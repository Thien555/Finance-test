import { and, eq, gte, inArray, lte, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppDb } from "@/lib/db/client";
import {
  accountingPeriod,
  coa,
  company,
  exceptionLog,
  exrate,
  gatewayCompanyMapping,
  journalLineRule,
  journalType,
  mappingBankAccount,
  partners,
} from "@/lib/db/schema";
import { MasterIndex } from "@/lib/engine/masters";
import { nowIso } from "@/lib/engine/parse";
import { PeriodLocks } from "@/lib/engine/period-lock";
import type { ExceptionDraft } from "@/lib/engine/types";

/** Phạm vi chạy Build/Post/Unpost/Unbuild */
export interface Scope {
  comCode?: string | null;
  periodFrom?: string | null; // YYYYMM
  periodTo?: string | null; // YYYYMM
  dataSource?: string | null;
}

export function loadMasterIndex(db: AppDb): MasterIndex {
  return new MasterIndex({
    partners: db.select().from(partners).all(),
    journalTypes: db.select().from(journalType).all(),
    lineRules: db.select().from(journalLineRule).all(),
    coa: db.select().from(coa).all(),
    exrates: db.select().from(exrate).all(),
    companies: db.select().from(company).all(),
    gatewayMappings: db.select().from(gatewayCompanyMapping).all(),
    bankMappings: db.select().from(mappingBankAccount).all(),
  });
}

export function chunk<T>(rows: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type DbOrTx = AppDb | Tx;

/** `batchId` null: exception không gắn lần chạy (VD tóm tắt kỳ khóa của lần Post không tạo PostingBatch) */
export function insertExceptions(db: DbOrTx, batchType: "IMPORT" | "BUILD" | "POST", batchId: number | null, drafts: ExceptionDraft[]) {
  const createdAt = nowIso();
  for (const c of chunk(drafts, 300)) {
    db.insert(exceptionLog)
      .values(c.map((d) => ({ ...d, BatchType: batchType, BatchID: batchId, CreatedAt: createdAt })))
      .run();
  }
}

/**
 * Xóa exception của 1 nguồn theo phạm vi. Dùng cho các nguồn ngân hàng/PSP: exception của chúng được gom
 * nhóm (Period = null) nên không xóa được bằng khóa/kỳ như Orders.
 * Exception thuộc kỳ khóa (`locks`) được giữ nguyên.
 */
export function deleteExceptionsByDataSource(db: DbOrTx, batchType: "BUILD" | "POST", dataSource: string, scope: Scope, locks = PeriodLocks.NONE) {
  const where: SQL[] = [eq(exceptionLog.BatchType, batchType), eq(exceptionLog.DataSource, dataSource)];
  if (scope.comCode) where.push(eq(exceptionLog.ComCode, scope.comCode));
  where.push(...notLocked(locks, exceptionLog.ComCode, exceptionLog.Period));
  db.delete(exceptionLog)
    .where(and(...where))
    .run();
}

/** Xóa exception theo SourceKey; exception thuộc kỳ khóa (`locks`) được giữ nguyên */
export function deleteExceptionsByKeys(db: DbOrTx, batchType: "BUILD" | "POST", keys: string[], locks = PeriodLocks.NONE) {
  const keep = notLocked(locks, exceptionLog.ComCode, exceptionLog.Period);
  for (const c of chunk([...new Set(keys)], 500)) {
    db.delete(exceptionLog)
      .where(and(eq(exceptionLog.BatchType, batchType), inArray(exceptionLog.SourceKey, c), ...keep))
      .run();
  }
}

// ───────────────────────────── Kỳ khóa sổ (guide §6.12) ─────────────────────────────

/** Các kỳ đang LOCKED — đọc 1 lần đầu mỗi thao tác (trong transaction nếu thao tác ghi) */
export function loadPeriodLocks(db: DbOrTx): PeriodLocks {
  return new PeriodLocks(
    db
      .select({ ComCode: accountingPeriod.ComCode, Period: accountingPeriod.Period })
      .from(accountingPeriod)
      .where(eq(accountingPeriod.Status, "LOCKED"))
      .all(),
  );
}

/** Biểu thức SQL cùng quy tắc với `lockKey` của engine: UPPER(TRIM(ComCode)) || '|' || TRIM(Period); NULL → '' (không bao giờ khóa) */
const lockKeySql = (comCode: SQLWrapper, period: SQLWrapper) =>
  sql`(upper(trim(coalesce(${comCode}, ''))) || '|' || trim(coalesce(${period}, '')))`;

const lockKeyList = (locks: PeriodLocks) =>
  sql.join(
    locks.keys.map((k) => sql`${k}`),
    sql`, `,
  );

/**
 * Điều kiện "không thuộc kỳ khóa" cho 1 bảng có cột ComCode + kỳ (cột Period, hoặc `periodOfDateColumn(...)`).
 * Không kỳ nào khóa → [] (SQL giữ y hệt như trước khi có khóa sổ).
 */
export function notLocked(locks: PeriodLocks, comCode: SQLWrapper, period: SQLWrapper): SQL[] {
  if (locks.isEmpty) return [];
  return [sql`${lockKeySql(comCode, period)} NOT IN (${lockKeyList(locks)})`];
}

/** Điều kiện "thuộc kỳ khóa" (để đếm phần bị bỏ qua). Không kỳ nào khóa → luôn sai */
export function lockedWhere(locks: PeriodLocks, comCode: SQLWrapper, period: SQLWrapper): SQL {
  if (locks.isEmpty) return sql`0 = 1`;
  return sql`${lockKeySql(comCode, period)} IN (${lockKeyList(locks)})`;
}

/**
 * Thay các exception INFO PERIOD_LOCKED (tóm tắt phần bị bỏ qua vì kỳ khóa) của 1 bước: xóa bản cũ trong phạm vi
 * (+ bản cũ trùng SourceKey với bản mới) rồi ghi `drafts`. Gọi cả khi `drafts` rỗng để dọn tóm tắt cũ sau khi mở khóa.
 * `dataSources` null = mọi nguồn.
 */
export function replaceLockSummaries(
  db: DbOrTx,
  batchType: "BUILD" | "POST",
  dataSources: string[] | null,
  scope: Scope,
  drafts: ExceptionDraft[],
  batchId: number | null,
) {
  const where: SQL[] = [eq(exceptionLog.BatchType, batchType), eq(exceptionLog.ExceptionType, "PERIOD_LOCKED"), eq(exceptionLog.Severity, "INFO")];
  if (dataSources) where.push(inArray(exceptionLog.DataSource, dataSources));
  const inScope = and(...scopeWhere(exceptionLog, { comCode: scope.comCode, periodFrom: scope.periodFrom, periodTo: scope.periodTo })) ?? sql`1 = 1`;
  const keys = drafts.map((d) => d.SourceKey).filter((k): k is string => !!k);
  db.delete(exceptionLog)
    .where(and(...where, keys.length ? or(inScope, inArray(exceptionLog.SourceKey, keys)) : inScope))
    .run();
  insertExceptions(db, batchType, batchId, drafts);
}

/** Điều kiện scope cho bảng có cột ComCode + Period (AccountingEvent, GLTrans) */
export function scopeWhere(
  cols: { ComCode: SQLiteColumn; Period: SQLiteColumn; DataSource?: SQLiteColumn },
  scope: Scope,
): SQL[] {
  const where: SQL[] = [];
  if (scope.comCode) where.push(eq(cols.ComCode, scope.comCode));
  if (scope.periodFrom) where.push(gte(cols.Period, scope.periodFrom));
  if (scope.periodTo) where.push(lte(cols.Period, scope.periodTo));
  if (scope.dataSource && cols.DataSource) where.push(eq(cols.DataSource, scope.dataSource.toUpperCase()));
  return where;
}

/** Kỳ YYYYMM tính từ cột ngày YYYY-MM-DD */
export function periodOfDateColumn(column: SQLiteColumn) {
  return sql<string>`substr(${column}, 1, 4) || substr(${column}, 6, 2)`;
}

export function describeScope(scope: Scope): string {
  const parts = [
    scope.comCode ? `ComCode=${scope.comCode}` : "mọi ComCode",
    scope.periodFrom || scope.periodTo ? `kỳ ${scope.periodFrom ?? "…"}→${scope.periodTo ?? "…"}` : "mọi kỳ",
  ];
  if (scope.dataSource) parts.push(`DataSource=${scope.dataSource}`);
  return parts.join(", ");
}
