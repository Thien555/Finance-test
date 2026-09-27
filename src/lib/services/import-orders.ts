/**
 * (1) IMPORT: file order (.csv/.xlsx) → RawOrders + ImportBatch
 *  - Khóa dòng = ItemCode
 *  - Dòng đã tồn tại: giống hệt → bỏ qua; khác & chưa build → thay thế; khác & đã build → lỗi (phải Unbuild trước)
 *  - Khác & item còn nằm trong AccountingEvent bất kỳ (dù BuildStatus nào) → lỗi (Unbuild, hoặc Unpost + Unbuild nếu đã POSTED),
 *    chống ghi sổ trùng khi đổi ngày giao / gateway
 *  - Kỳ khóa sổ (guide §6.12): dòng mới/thay mà (ComCode theo gateway, kỳ FulfilledAt) mới **hoặc** cũ bị khóa → lỗi dòng
 *    (`LockedRows`); dòng chưa giao không thuộc kỳ nào nên không bị chặn, dòng giống hệt vẫn bỏ qua như cũ
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, importBatch, rawOrders } from "@/lib/db/schema";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { orderSourceId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { firstLocked, lockMsg, orderRowRefs, type PeriodLocks, periodOfDate } from "@/lib/engine/period-lock";
import { parseItemCodes } from "@/lib/engine/reconcile-events";
import { readTable } from "@/lib/io/read-table";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";
import { chunk, loadMasterIndex, loadPeriodLocks } from "./common";

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
  /** Dòng bị từ chối vì thuộc kỳ khóa sổ (đã tính trong ErrorRows) */
  LockedRows: number;
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
      LockedRows: 0,
      errors: [{ row: 1, key: null, message }],
    };
  }

  const index = loadMasterIndex(db);
  const errors: ImportRowError[] = [];
  const normalized = table.records.map((record, i) => ({ rowNumber: i + 2, result: normalizeOrderRow(record, map) }));

  const itemCodes = normalized.flatMap((n) => (n.result.ok ? [n.result.row.ItemCode] : []));
  const existing = new Map<
    string,
    {
      RawOrderID: number;
      RowHash: string;
      BuildStatus: string;
      OrderId: string;
      FulfilledAt: string | null;
      ComCode: string | null;
      PaymentGatewayName: string | null;
    }
  >();
  for (const c of chunk(itemCodes, 500)) {
    for (const r of db
      .select({
        ItemCode: rawOrders.ItemCode,
        RawOrderID: rawOrders.RawOrderID,
        RowHash: rawOrders.RowHash,
        BuildStatus: rawOrders.BuildStatus,
        OrderId: rawOrders.OrderId,
        FulfilledAt: rawOrders.FulfilledAt,
        ComCode: rawOrders.ComCode,
        PaymentGatewayName: rawOrders.PaymentGatewayName,
      })
      .from(rawOrders)
      .where(inArray(rawOrders.ItemCode, c))
      .all()) {
      existing.set(r.ItemCode, r);
    }
  }

  // Dòng đổi dữ liệu mà item còn nằm trong AccountingEvent → không cho thay (kể cả khi BuildStatus không còn BUILT,
  // VD gateway bị gỡ mapping rồi Build → ERROR, rồi Unpost): đổi FulfilledAt/gateway rồi Build lại sẽ để event cũ ở khóa cũ
  // → ghi sổ trùng. Dòng BUILT đã bị chặn ở dưới; ERROR/SKIPPED bình thường không có event nên không bị ảnh hưởng.
  const changedOrders = new Set<string>();
  for (const { result } of normalized) {
    const old = result.ok ? existing.get(result.row.ItemCode) : undefined;
    if (result.ok && old && old.RowHash !== result.row.RowHash && old.BuildStatus !== "BUILT") changedOrders.add(old.OrderId);
  }
  type OrderEvent = Pick<AccountingEventRow, "AccountingEventID" | "SourceID" | "ComCode" | "Period" | "PostStatus"> & { items: Set<string> | null };
  const eventsByOrder = new Map<string, OrderEvent[]>();
  for (const c of chunk([...changedOrders], 500)) {
    for (const { OrderID, ItemCodes, ...e } of db
      .select({
        AccountingEventID: accountingEvent.AccountingEventID,
        SourceID: accountingEvent.SourceID,
        ComCode: accountingEvent.ComCode,
        Period: accountingEvent.Period,
        PostStatus: accountingEvent.PostStatus,
        OrderID: accountingEvent.OrderID,
        ItemCodes: accountingEvent.ItemCodes,
      })
      .from(accountingEvent)
      .where(and(eq(accountingEvent.DataSource, ORDERS_DATA_SOURCE), inArray(accountingEvent.OrderID, c)))
      .all()) {
      const list = eventsByOrder.get(OrderID ?? "") ?? [];
      list.push({ ...e, items: parseItemCodes(ItemCodes) });
      eventsByOrder.set(OrderID ?? "", list);
    }
  }
  /** Lý do không cho thay dòng (item còn nằm trong event), null nếu được thay; `locked`: event đó thuộc kỳ khóa sổ */
  const blockedByEvent = (
    itemCode: string,
    old: { OrderId: string; FulfilledAt: string | null },
    locks: PeriodLocks,
  ): { message: string; locked: boolean } | null => {
    const oldSourceId = old.FulfilledAt ? orderSourceId(old.OrderId, old.FulfilledAt) : null;
    const hits = (eventsByOrder.get(old.OrderId) ?? []).filter((e) =>
      // event cũ chưa có ItemCodes: coi là chứa item nếu cùng đơn + ngày giao
      e.items ? e.items.has(itemCode) : !!oldSourceId && e.SourceID === oldSourceId,
    );
    // Event ở kỳ khóa báo trước: lời khuyên "Unpost/Unbuild kỳ đó" bên dưới không làm được khi kỳ còn khóa
    const locked = hits.find((h) => locks.isLocked(h));
    if (locked) return { message: lockMsg.importEvent(locked.AccountingEventID, locked, locked.PostStatus), locked: true };
    const e = hits.find((h) => h.PostStatus === "POSTED") ?? hits[0];
    if (!e) return null;
    const where = `event ${e.AccountingEventID}, ComCode ${e.ComCode} kỳ ${e.Period}`;
    if (!e.items) {
      const message =
        `Đơn + ngày giao của dòng có ${where}, ${e.PostStatus} tạo trước khi có cột ItemCodes (không biết chính xác item) và dữ liệu thay đổi → ` +
        `Build lại để bổ sung ItemCodes rồi import lại, hoặc ${e.PostStatus === "POSTED" ? "Unpost + " : ""}Unbuild ComCode ${e.ComCode} kỳ ${e.Period} trước`;
      return { message, locked: false };
    }
    const message =
      e.PostStatus === "POSTED"
        ? `Dòng đã ghi sổ (${where}, POSTED) và dữ liệu thay đổi → Unpost + Unbuild ComCode ${e.ComCode} kỳ ${e.Period} trước khi import lại`
        : `Dòng còn nằm trong AccountingEvent chưa post (${where}, ${e.PostStatus}) và dữ liệu thay đổi → Unbuild ComCode ${e.ComCode} kỳ ${e.Period} trước khi import lại`;
    return { message, locked: false };
  };

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;
  let lockedRows = 0;

  const batchId = db.transaction((tx) => {
    const locks = loadPeriodLocks(tx);
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
      if (old && old.RowHash === row.RowHash) {
        skipped++;
        continue;
      }
      // Kỳ khóa: giá trị mới (ComCode theo gateway × kỳ FulfilledAt) hoặc cũ (ComCode theo mapping + đã lưu × kỳ cũ)
      const lockedRef = firstLocked(locks, [
        { ComCode: values.ComCode, Period: periodOfDate(row.FulfilledAt) },
        ...(old ? orderRowRefs(old, index) : []),
      ]);
      if (lockedRef) {
        errors.push({ row: rowNumber, key: row.ItemCode, message: lockMsg.importRow(lockedRef) });
        lockedRows++;
        continue;
      }
      if (!old) {
        tx.insert(rawOrders).values(values).run();
        inserted++;
      } else if (old.BuildStatus === "BUILT") {
        errors.push({ row: rowNumber, key: row.ItemCode, message: "Dòng đã build thành AccountingEvent và dữ liệu thay đổi → Unbuild trước khi import lại" });
      } else {
        const blocked = blockedByEvent(row.ItemCode, old, locks);
        if (blocked) {
          errors.push({ row: rowNumber, key: row.ItemCode, message: blocked.message });
          if (blocked.locked) lockedRows++;
        } else {
          tx.update(rawOrders).set(values).where(eq(rawOrders.RawOrderID, old.RawOrderID)).run();
          replaced++;
        }
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
    LockedRows: lockedRows,
    errors: errors.slice(0, 200),
  };
}
