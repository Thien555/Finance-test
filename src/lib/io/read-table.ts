/**
 * Đọc file upload (.csv / .xlsx) → { headers, records }.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { BadRequestError } from "@/lib/errors";

export interface TableData {
  sheetName: string | null;
  headers: string[];
  records: Record<string, unknown>[];
}

export interface ReadTableOptions {
  /** Chọn sheet theo tên (không phân biệt hoa thường). Dùng cho workbook nhiều nguồn như Data-khac-order.xlsx */
  sheetName?: string;
  /** Không có sheetName → chọn sheet đầu tiên có header này (mẫu cũ của Orders) */
  preferredHeader?: string;
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v !== "object") return v;
  if ("richText" in v) return v.richText.map((t) => t.text).join("");
  if ("text" in v && "hyperlink" in v) return v.text;
  if ("result" in v) return cellValue(v.result as ExcelJS.CellValue);
  if ("error" in v) return null;
  return String(v);
}

function readCsv(buffer: Buffer): TableData {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { sheetName: null, headers: parsed.meta.fields ?? [], records: parsed.data };
}

async function readXlsx(buffer: Buffer, options: ReadTableOptions): Promise<TableData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  // Array.from (không phải .map) để ô tiêu đề trống giữa các cột thành "" thay vì lỗ hổng mảng:
  // .map bỏ qua lỗ hổng → các cột sau đó không bao giờ được đọc (bug §13.3 #1)
  const headerOf = (ws: ExcelJS.Worksheet) => {
    const values = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1);
    return Array.from({ length: values.length }, (_, i) => String(cellValue(values[i] ?? null) ?? "").trim());
  };

  const { sheetName, preferredHeader } = options;
  let ws: ExcelJS.Worksheet | undefined;
  if (sheetName) {
    ws = wb.worksheets.find((s) => s.name.trim().toLowerCase() === sheetName.trim().toLowerCase());
    if (!ws) {
      const available = wb.worksheets.map((s) => s.name).join(", ");
      throw new BadRequestError(`File không có sheet "${sheetName}". Các sheet đang có: ${available}`);
    }
  } else {
    ws =
      wb.worksheets.find((s) =>
        preferredHeader ? headerOf(s).some((h) => h.toLowerCase() === preferredHeader.toLowerCase()) : true,
      ) ?? wb.worksheets[0];
  }
  if (!ws) return { sheetName: null, headers: [], records: [] };

  const headers = headerOf(ws);
  const records: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, unknown> = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const value = cellValue(row.getCell(i + 1).value);
      if (value !== null && value !== "") hasValue = true;
      record[h] = value;
    });
    if (hasValue) records.push(record);
  });
  return { sheetName: ws.name, headers, records };
}

export async function readTable(
  buffer: Buffer,
  fileName: string,
  options: ReadTableOptions | string = {},
): Promise<TableData> {
  const opts: ReadTableOptions = typeof options === "string" ? { preferredHeader: options } : options;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return readXlsx(buffer, opts);
  // .csv/.txt chỉ có 1 bảng → bỏ qua sheetName (dùng khi tách sheet ra file rời để test)
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return readCsv(buffer);
  throw new BadRequestError("Chỉ hỗ trợ file .csv hoặc .xlsx");
}
