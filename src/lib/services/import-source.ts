/**
 * (1) IMPORT nguồn ngoài Orders: sheet của file .xlsx (hoặc .csv tách riêng) → bảng raw + ImportBatch.
 *
 *  - Khóa dòng = `SourceKey` (xem src/lib/sources/normalize.ts) — không phụ thuộc cột người dùng điền tay
 *  - Dòng đã có: `RowHash` giống → bỏ qua; khác & còn event → lỗi (POSTED: Unpost + Unbuild trước; chưa post: Unbuild trước);
 *    khác & đã build → lỗi (Unbuild trước); khác & chưa build, không còn event → thay thế
 *
 * Quy tắc cuối chính là thứ chống ghi sổ trùng cho các nguồn này: 1 dòng raw ⇄ 1 bộ event, nên sửa tay
 * cột JournalType/PartnerCode sau khi đã Build/Post đều bị chặn ngay tại đây.
 *
 * Kỳ khóa sổ (guide §6.12): dòng mới/thay mà (ComCode, kỳ PostingDate) mới **hoặc** cũ bị khóa → lỗi dòng (`LockedRows`);
 * khi có kỳ khóa, dòng mới/thay mà event cùng SourceID đang ở kỳ khóa cũng bị từ chối. Dòng giống hệt vẫn bỏ qua như cũ.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { type AccountingEventRow, accountingEvent, importBatch, rawPaypal, rawPipo, rawStripe } from "@/lib/db/schema";
import { bankSourceId } from "@/lib/engine/keys";
import { nowIso } from "@/lib/engine/parse";
import { firstLocked, lockMsg, periodOfDate } from "@/lib/engine/period-lock";
import { paypalSpec } from "@/lib/engine/sources/paypal";
import { pipoSpec } from "@/lib/engine/sources/pipo";
import { stripeSpec } from "@/lib/engine/sources/stripe";
import { readTable } from "@/lib/io/read-table";
import { canonicalHeaderMap, SOURCE_META, type SourceKey } from "@/lib/sources/columns";
import { normalizePaypalRow, normalizePipoRow, normalizeStripeRow, type NormalizeResult } from "@/lib/sources/normalize";
import { chunk, type DbOrTx, loadPeriodLocks } from "./common";

export interface ImportRowError {
  row: number;
  key: string | null;
  message: string;
}

export interface ImportSourceResult {
  ImportBatchID: number;
  Status: string;
  DataSource: string;
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

type RawShape = { SourceKey: string; RowHash: string; ComCode?: string | null; PostingDate?: string | null };
type ExistingRow = { id: number; RowHash: string; BuildStatus: string; ComCode: string | null; PostingDate: string | null };

interface SourceAdapter<T extends RawShape> {
  /** AccountingEvent.DataSource do engine ghi (`spec.dataSource`) — phần đầu SourceID `bankSourceId(ds, SourceKey)` */
  eventDataSource: string;
  normalize(record: Record<string, unknown>, map: Map<string, string>): NormalizeResult<T>;
  loadExisting(keys: string[]): Map<string, ExistingRow>;
  insert(tx: DbOrTx, values: T & { ImportBatchID: number }): void;
  update(tx: DbOrTx, id: number, values: T & { ImportBatchID: number }): void;
}

function adapterOf(source: SourceKey): SourceAdapter<RawShape> {
  const db = getDb();
  const collect = <R extends { SourceKey: string; RowHash: string; BuildStatus: string; ComCode: string | null; PostingDate: string | null }>(
    rows: R[],
    idOf: (r: R) => number,
  ) => {
    const map = new Map<string, ExistingRow>();
    for (const r of rows) {
      map.set(r.SourceKey, { id: idOf(r), RowHash: r.RowHash, BuildStatus: r.BuildStatus, ComCode: r.ComCode, PostingDate: r.PostingDate });
    }
    return map;
  };

  switch (source) {
    case "paypal":
      return {
        eventDataSource: paypalSpec.dataSource,
        normalize: (record, map) => normalizePaypalRow(record, map, SOURCE_META.paypal.columns),
        loadExisting: (keys) => {
          const out = new Map<string, ExistingRow>();
          for (const c of chunk(keys, 500)) {
            for (const [k, v] of collect(
              db
                .select({
                  SourceKey: rawPaypal.SourceKey,
                  RowHash: rawPaypal.RowHash,
                  BuildStatus: rawPaypal.BuildStatus,
                  ComCode: rawPaypal.ComCode,
                  PostingDate: rawPaypal.PostingDate,
                  id: rawPaypal.RawPaypalID,
                })
                .from(rawPaypal)
                .where(inArray(rawPaypal.SourceKey, c))
                .all(),
              (r) => r.id,
            )) {
              out.set(k, v);
            }
          }
          return out;
        },
        insert: (tx, values) => tx.insert(rawPaypal).values(values as never).run(),
        update: (tx, id, values) => tx.update(rawPaypal).set(values as never).where(eq(rawPaypal.RawPaypalID, id)).run(),
      } as SourceAdapter<RawShape>;
    case "stripe":
      return {
        eventDataSource: stripeSpec.dataSource,
        normalize: (record, map) => normalizeStripeRow(record, map, SOURCE_META.stripe.columns),
        loadExisting: (keys) => {
          const out = new Map<string, ExistingRow>();
          for (const c of chunk(keys, 500)) {
            for (const [k, v] of collect(
              db
                .select({
                  SourceKey: rawStripe.SourceKey,
                  RowHash: rawStripe.RowHash,
                  BuildStatus: rawStripe.BuildStatus,
                  ComCode: rawStripe.ComCode,
                  PostingDate: rawStripe.PostingDate,
                  id: rawStripe.RawStripeID,
                })
                .from(rawStripe)
                .where(inArray(rawStripe.SourceKey, c))
                .all(),
              (r) => r.id,
            )) {
              out.set(k, v);
            }
          }
          return out;
        },
        insert: (tx, values) => tx.insert(rawStripe).values(values as never).run(),
        update: (tx, id, values) => tx.update(rawStripe).set(values as never).where(eq(rawStripe.RawStripeID, id)).run(),
      } as SourceAdapter<RawShape>;
    case "pipo":
      return {
        eventDataSource: pipoSpec.dataSource,
        normalize: (record, map) => normalizePipoRow(record, map, SOURCE_META.pipo.columns),
        loadExisting: (keys) => {
          const out = new Map<string, ExistingRow>();
          for (const c of chunk(keys, 500)) {
            for (const [k, v] of collect(
              db
                .select({
                  SourceKey: rawPipo.SourceKey,
                  RowHash: rawPipo.RowHash,
                  BuildStatus: rawPipo.BuildStatus,
                  ComCode: rawPipo.ComCode,
                  PostingDate: rawPipo.PostingDate,
                  id: rawPipo.RawPipoID,
                })
                .from(rawPipo)
                .where(inArray(rawPipo.SourceKey, c))
                .all(),
              (r) => r.id,
            )) {
              out.set(k, v);
            }
          }
          return out;
        },
        insert: (tx, values) => tx.insert(rawPipo).values(values as never).run(),
        update: (tx, id, values) => tx.update(rawPipo).set(values as never).where(eq(rawPipo.RawPipoID, id)).run(),
      } as SourceAdapter<RawShape>;
  }
}

export async function importSourceFile(source: SourceKey, buffer: Buffer, fileName: string): Promise<ImportSourceResult> {
  const meta = SOURCE_META[source];
  const sheet = meta.sheet;
  const adapter = adapterOf(source);
  const db = getDb();
  const uploadedAt = nowIso();

  // .csv chỉ có 1 bảng nên bỏ qua sheetName; .xlsx thì lấy đúng sheet theo tên
  const table = await readTable(buffer, fileName, { sheetName: fileName.toLowerCase().endsWith(".xlsx") ? sheet : undefined });
  const { map, missing } = canonicalHeaderMap(table.headers, meta.columns, meta.required);

  if (missing.length > 0) {
    const message = `Sheet "${sheet}" thiếu cột bắt buộc: ${missing.join(", ")}`;
    const [batch] = db
      .insert(importBatch)
      .values({
        DataSource: meta.dataSource,
        FileName: `${fileName} [${sheet}]`,
        UploadedAt: uploadedAt,
        Status: "FAILED",
        TotalRows: table.records.length,
        ErrorMessage: message,
      })
      .returning()
      .all();
    return {
      ImportBatchID: batch.ImportBatchID,
      Status: "FAILED",
      DataSource: meta.dataSource,
      FileName: fileName,
      sheetName: sheet,
      TotalRows: table.records.length,
      InsertedRows: 0,
      ReplacedRows: 0,
      SkippedRows: 0,
      ErrorRows: table.records.length,
      LockedRows: 0,
      errors: [{ row: 1, key: null, message }],
    };
  }

  const errors: ImportRowError[] = [];
  const normalized = table.records.map((record, i) => ({ rowNumber: i + 2, result: adapter.normalize(record, map) }));
  const existing = adapter.loadExisting(normalized.flatMap((n) => (n.result.ok ? [n.result.row.SourceKey] : [])));

  let inserted = 0;
  let replaced = 0;
  let skipped = 0;
  let lockedRows = 0;

  const batchId = db.transaction((tx) => {
    const [batch] = tx
      .insert(importBatch)
      .values({
        DataSource: meta.dataSource,
        FileName: `${fileName} [${sheet}]`,
        UploadedAt: uploadedAt,
        Status: "RUNNING",
        TotalRows: table.records.length,
      })
      .returning()
      .all();

    // Event còn trong DB của dòng sắp thay (1 dòng raw ⇄ 1 bộ event): thay dòng rồi Build lại sẽ sinh event mới bên cạnh event
    // cũ → ghi sổ trùng, nên không cho thay (như blockedByEvent của Orders). Dòng đổi nội dung luôn được kiểm; khi có kỳ khóa kiểm
    // cả dòng mới. Ưu tiên event thuộc kỳ khóa, rồi POSTED.
    const locks = loadPeriodLocks(tx);
    type HeldBy = Pick<AccountingEventRow, "AccountingEventID" | "ComCode" | "Period" | "PostStatus"> & { locked: boolean };
    const eventOf = new Map<string, HeldBy>();
    const rank = (e: HeldBy) => (e.locked ? 2 : 0) + (e.PostStatus === "POSTED" ? 1 : 0);
    const touched = normalized.flatMap(({ result }) => {
      if (!result.ok) return [];
      const old = existing.get(result.row.SourceKey);
      if (old ? old.RowHash === result.row.RowHash : locks.isEmpty) return [];
      return [bankSourceId(adapter.eventDataSource, result.row.SourceKey)];
    });
    for (const c of chunk([...new Set(touched)], 500)) {
      for (const { SourceID, ...e } of tx
        .select({
          SourceID: accountingEvent.SourceID,
          AccountingEventID: accountingEvent.AccountingEventID,
          ComCode: accountingEvent.ComCode,
          Period: accountingEvent.Period,
          PostStatus: accountingEvent.PostStatus,
        })
        .from(accountingEvent)
        .where(and(eq(accountingEvent.DataSource, adapter.eventDataSource), inArray(accountingEvent.SourceID, c)))
        .all()) {
        const held = { ...e, locked: locks.isLocked(e) };
        const prev = eventOf.get(SourceID ?? "");
        if (!prev || rank(held) > rank(prev)) eventOf.set(SourceID ?? "", held);
      }
    }

    const seenInFile = new Set<string>();
    for (const { rowNumber, result } of normalized) {
      if (!result.ok) {
        errors.push({ row: rowNumber, key: result.key, message: result.error });
        continue;
      }
      const row = result.row;
      if (seenInFile.has(row.SourceKey)) {
        errors.push({ row: rowNumber, key: row.SourceKey, message: `Dòng bị trùng trong file (SourceKey ${row.SourceKey})` });
        continue;
      }
      seenInFile.add(row.SourceKey);

      const values = { ...row, ImportBatchID: batch.ImportBatchID };
      const old = existing.get(row.SourceKey);
      if (old && old.RowHash === row.RowHash) {
        skipped++;
        continue;
      }
      // Kỳ khóa: (ComCode, kỳ PostingDate) mới hoặc cũ của dòng, rồi event cùng SourceID
      const lockedRef = firstLocked(locks, [
        { ComCode: row.ComCode, Period: periodOfDate(row.PostingDate) },
        ...(old ? [{ ComCode: old.ComCode, Period: periodOfDate(old.PostingDate) }] : []),
      ]);
      const heldBy = eventOf.get(bankSourceId(adapter.eventDataSource, row.SourceKey));
      const lockedMessage = lockedRef
        ? lockMsg.importRow(lockedRef)
        : heldBy?.locked
          ? lockMsg.importEvent(heldBy.AccountingEventID, heldBy, heldBy.PostStatus)
          : null;
      if (lockedMessage) {
        errors.push({ row: rowNumber, key: row.SourceKey, message: lockedMessage });
        lockedRows++;
        continue;
      }
      if (!old) {
        adapter.insert(tx, values);
        inserted++;
      } else if (heldBy) {
        const where = `event ${heldBy.AccountingEventID}, ComCode ${heldBy.ComCode} kỳ ${heldBy.Period}`;
        errors.push({
          row: rowNumber,
          key: row.SourceKey,
          message:
            heldBy.PostStatus === "POSTED"
              ? `Dòng đã ghi sổ (${where}, POSTED) và dữ liệu thay đổi → Unpost + Unbuild ${meta.dataSource} ComCode ${heldBy.ComCode} kỳ ${heldBy.Period} trước khi import lại`
              : `Dòng còn nằm trong AccountingEvent chưa post (${where}, ${heldBy.PostStatus}) và dữ liệu thay đổi → Unbuild ${meta.dataSource} ComCode ${heldBy.ComCode} kỳ ${heldBy.Period} trước khi import lại`,
        });
      } else if (old.BuildStatus === "BUILT") {
        errors.push({
          row: rowNumber,
          key: row.SourceKey,
          message: `Dòng đã build thành AccountingEvent và dữ liệu thay đổi → Unbuild ${meta.dataSource} trước khi import lại`,
        });
      } else {
        adapter.update(tx, old.id, values);
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
    DataSource: meta.dataSource,
    FileName: fileName,
    sheetName: sheet,
    TotalRows: table.records.length,
    InsertedRows: inserted,
    ReplacedRows: replaced,
    SkippedRows: skipped,
    ErrorRows: errors.length,
    LockedRows: lockedRows,
    errors: errors.slice(0, 200),
  };
}
