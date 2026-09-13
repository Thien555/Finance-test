/**
 * Chuẩn hóa 1 dòng file order (CSV/XLSX) → RawOrders.
 */
import type { RawOrderInsert } from "@/lib/db/schema";
import { sha256 } from "@/lib/engine/keys";
import { parseDate, parseDateTime, parseNumber, toText } from "@/lib/engine/parse";
import { ORDER_COLUMNS, REQUIRED_ORDER_COLUMNS } from "./columns";

export { ORDER_COLUMNS, REQUIRED_ORDER_COLUMNS };

export type NormalizedOrder = Omit<RawOrderInsert, "RawOrderID" | "ImportBatchID" | "ComCode" | "BuildStatus" | "BuildMessage">;

export type NormalizeResult = { ok: true; row: NormalizedOrder } | { ok: false; key: string | null; error: string };

/** Map header file → tên cột chuẩn (không phân biệt hoa thường/khoảng trắng) */
export function canonicalHeaders(headers: string[]): { map: Map<string, string>; missing: string[] } {
  const wanted = new Map(ORDER_COLUMNS.map(([name]) => [name.toLowerCase(), name]));
  const map = new Map<string, string>();
  for (const h of headers) {
    const canonical = wanted.get(h.trim().toLowerCase().replace(/\s+/g, ""));
    if (canonical) map.set(h, canonical);
  }
  const present = new Set(map.values());
  return { map, missing: REQUIRED_ORDER_COLUMNS.filter((c) => !present.has(c)) };
}

export function normalizeOrderRow(record: Record<string, unknown>, headerMap: Map<string, string>): NormalizeResult {
  const source: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(record)) {
    const canonical = headerMap.get(header);
    if (canonical) source[canonical] = value;
  }

  const row: Record<string, string | number | null> = {};
  for (const [name, kind] of ORDER_COLUMNS) {
    const v = source[name];
    switch (kind) {
      case "number":
        row[name] = parseNumber(v);
        break;
      case "date":
        row[name] = parseDate(v) ?? toText(v);
        break;
      case "datetime":
        row[name] = parseDateTime(v) ?? toText(v);
        break;
      default:
        row[name] = toText(v);
    }
  }

  const key = (row.ItemCode as string | null) ?? null;
  if (!row.OrderId) return { ok: false, key, error: "Thiếu OrderId" };
  if (!row.ItemCode) return { ok: false, key, error: "Thiếu ItemCode" };
  if (source.FulfilledAt !== undefined && toText(source.FulfilledAt) && !parseDate(source.FulfilledAt)) {
    return { ok: false, key, error: `FulfilledAt không đúng định dạng ngày: "${toText(source.FulfilledAt)}"` };
  }

  return {
    ok: true,
    row: { ...(row as unknown as Omit<NormalizedOrder, "RowHash">), RowHash: sha256(row) },
  };
}
