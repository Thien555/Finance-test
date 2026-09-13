/**
 * (1) IMPORT: file order (.csv/.xlsx) → RawOrders + ImportBatch
 *  - Khóa dòng = ItemCode
 *  - Dòng đã tồn tại: giống hệt → bỏ qua; khác & chưa build → thay thế; khác & đã build → lỗi (phải Unbuild trước)
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { importBatch, rawOrders } from "@/lib/db/schema";
import { nowIso } from "@/lib/engine/parse";
import { readTable } from "@/lib/io/read-table";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";
import { chunk, loadMasterIndex } from "./common";

export interface ImportRowError {
  row: number;
  key: string | null;
  message: string;
}

export interface ImportOrdersResult {
  ImportBatchID: number;
  Status: string;
  FileName: string;
  sheetName: string | null;
  TotalRows: number;
  InsertedRows: number;
  ReplacedRows: number;
  SkippedRows: number;
  ErrorRows: number;
  errors: ImportRowError[];
}

export async function importOrders(buffer: Buffer, fileName: string): Promise<ImportOrdersResult> {
  const db = getDb();
  const uploadedAt = nowIso();
  const table = await readTable(buffer, fileName, "OrderId");
  const { map, missing } = canonicalHeaders(table.headers);

  if (missing.length > 0) {
    const message = `File thiếu cột bắt buộc: ${missing.join(", ")}`;
    const [batch] = db
      .insert(importBatch)
      .values({ DataSource: "ORDERS", FileName: fileName, UploadedAt: uploadedAt, Status: "FAILED", TotalRows: table.records.length, ErrorMessage: message })
      .returning()
      .all();
    return {
      ImportBatchID: batch.ImportBatchID,
      Status: "FAILED",
      FileName: fileName,
      sheetName: table.sheetName,
      TotalRows: table.records.length,
      InsertedRows: 0,
      ReplacedRows: 0,
      SkippedRows: 0,
      ErrorRows: table.records.length,
      errors: [{ row: 1, key: null, message }],
    };
  }

  const index = loadMasterIndex(db);
  const errors: ImportRowError[] = [];
  const normalized = table.records.map((record, i) => ({ rowNumber: i + 2, result: normalizeOrderRow(record, map) }));

  const itemCodes = normalized.flatMap((n) => (n.result.ok ? [n.result.row.ItemCode] : []));
  const existing = new Map<string, { RawOrderID: number; RowHash: string; BuildStatus: string }>();
  for (const c of chunk(itemCodes, 500)) {
    for (const r of db
      .select({ ItemCode: rawOrders.ItemCode, RawOrderID: rawOrders.RawOrderID, RowHash: rawOrders.RowHash, BuildStatus: rawOrders.BuildStatus })
      .from(rawOrders)
      .where(inArray(rawOrders.ItemCode, c))
      .all()) {
      existing.set(r.ItemCode, r);
    }
  }

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  const batchId = db.transaction((tx) => {
    const [batch] = tx
      .insert(importBatch)
      .values({ DataSource: "ORDERS", FileName: fileName, UploadedAt: uploadedAt, Status: "RUNNING", TotalRows: table.records.length })
      .returning()
      .all();

    const seenInFile = new Set<string>();
    for (const { rowNumber, result } of normalized) {
      if (!result.ok) {
        errors.push({ row: rowNumber, key: result.key, message: result.error });
        continue;
      }
      const row = result.row;
      if (seenInFile.has(row.ItemCode)) {
        errors.push({ row: rowNumber, key: row.ItemCode, message: "ItemCode bị trùng trong file" });
        continue;
      }
      seenInFile.add(row.ItemCode);

      const values = {
        ...row,
        ImportBatchID: batch.ImportBatchID,
        ComCode: index.comCodeOfGateway(row.PaymentGatewayName) ?? null,
        BuildStatus: "NOT_BUILT",
        BuildMessage: null,
      };
      const old = existing.get(row.ItemCode);
      if (!old) {
        tx.insert(rawOrders).values(values).run();
        inserted++;
      } else if (old.RowHash === row.RowHash) {
        skipped++;
      } else if (old.BuildStatus === "BUILT") {
        errors.push({ row: rowNumber, key: row.ItemCode, message: "Dòng đã build thành AccountingEvent và dữ liệu thay đổi → Unbuild trước khi import lại" });
      } else {
        tx.update(rawOrders).set(values).where(eq(rawOrders.RawOrderID, old.RawOrderID)).run();
        replaced++;
      }
    }

    const success = inserted + replaced;
    const status = errors.length === 0 ? "SUCCESS" : success > 0 || skipped > 0 ? "PARTIAL" : "FAILED";
    tx.update(importBatch)
      .set({
        Status: status,
        SuccessRows: success,
        ErrorRows: errors.length,
        SkippedRows: skipped,
        ErrorMessage: errors.length ? `${errors.length} dòng lỗi` : null,
        ErrorDetails: errors.length ? JSON.stringify(errors.slice(0, 500)) : null,
      })
      .where(eq(importBatch.ImportBatchID, batch.ImportBatchID))
      .run();
    return batch.ImportBatchID;
  });

  const success = inserted + replaced;
  return {
    ImportBatchID: batchId,
    Status: errors.length === 0 ? "SUCCESS" : success > 0 || skipped > 0 ? "PARTIAL" : "FAILED",
    FileName: fileName,
    sheetName: table.sheetName,
    TotalRows: table.records.length,
    InsertedRows: inserted,
    ReplacedRows: replaced,
    SkippedRows: skipped,
    ErrorRows: errors.length,
    errors: errors.slice(0, 200),
  };
}
