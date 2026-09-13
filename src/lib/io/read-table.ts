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

async function readXlsx(buffer: Buffer, preferredHeader?: string): Promise<TableData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const headerOf = (ws: ExcelJS.Worksheet) =>
    (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((h) => String(cellValue(h) ?? "").trim());

  const ws =
    wb.worksheets.find((s) =>
      preferredHeader ? headerOf(s).some((h) => h.toLowerCase() === preferredHeader.toLowerCase()) : true,
    ) ?? wb.worksheets[0];
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

export async function readTable(buffer: Buffer, fileName: string, preferredHeader?: string): Promise<TableData> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return readXlsx(buffer, preferredHeader);
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return readCsv(buffer);
  throw new BadRequestError("Chỉ hỗ trợ file .csv hoặc .xlsx");
}
