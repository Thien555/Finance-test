/** Xuất Excel (.xlsx) — cột giữ đúng thứ tự sheet mẫu GlTrans / AccountingEvent. */
import ExcelJS from "exceljs";
import type { AccountingEventRow, GLTransRow } from "@/lib/db/schema";
import { EVENT_EXPORT_COLUMNS, GL_EXPORT_COLUMNS } from "@/lib/gl-columns";

export { EVENT_EXPORT_COLUMNS, GL_EXPORT_COLUMNS };

const MONEY = new Set(["InputDr", "InputCr", "AccountedDr", "AccountedCr", "Amount"]);
const DATE = new Set(["TransDate", "DocDate", "PostingDate"]);

function addSheet<T extends Record<string, unknown>>(wb: ExcelJS.Workbook, name: string, columns: (keyof T & string)[], rows: T[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((key) => ({
    header: key,
    key,
    width: Math.min(Math.max(key.length + 2, 12), key === "Description" || key === "PostingGroupKey" ? 60 : 28),
    style: MONEY.has(key) ? { numFmt: "#,##0.00" } : DATE.has(key) ? { numFmt: "yyyy-mm-dd" } : key === "XRate" ? { numFmt: "0.0000" } : {},
  }));
  for (const r of rows) {
    const values: Record<string, unknown> = {};
    for (const key of columns) {
      const v = r[key];
      values[key] = DATE.has(key) && typeof v === "string" ? new Date(`${v}T00:00:00Z`) : v;
    }
    ws.addRow(values);
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

export async function glWorkbook(rows: GLTransRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = addSheet(wb, "GlTrans", GL_EXPORT_COLUMNS, rows);
  if (rows.length) {
    const total = ws.addRow({
      Description: "TỔNG",
      InputDr: rows.reduce((a, r) => a + r.InputDr, 0),
      InputCr: rows.reduce((a, r) => a + r.InputCr, 0),
      AccountedDr: rows.reduce((a, r) => a + r.AccountedDr, 0),
      AccountedCr: rows.reduce((a, r) => a + r.AccountedCr, 0),
    });
    total.font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function eventsWorkbook(rows: AccountingEventRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addSheet(wb, "AccountingEvent", EVENT_EXPORT_COLUMNS, rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
