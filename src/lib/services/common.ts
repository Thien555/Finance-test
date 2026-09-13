import { and, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppDb } from "@/lib/db/client";
import {
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

export function insertExceptions(db: DbOrTx, batchType: "IMPORT" | "BUILD" | "POST", batchId: number, drafts: ExceptionDraft[]) {
  const createdAt = nowIso();
  for (const c of chunk(drafts, 300)) {
    db.insert(exceptionLog)
      .values(c.map((d) => ({ ...d, BatchType: batchType, BatchID: batchId, CreatedAt: createdAt })))
      .run();
  }
}

export function deleteExceptionsByKeys(db: DbOrTx, batchType: "BUILD" | "POST", keys: string[]) {
  for (const c of chunk([...new Set(keys)], 500)) {
    db.delete(exceptionLog)
      .where(and(eq(exceptionLog.BatchType, batchType), inArray(exceptionLog.SourceKey, c)))
      .run();
  }
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
