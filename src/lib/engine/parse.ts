/**
 * Chuẩn hóa giá trị ô từ CSV/XLSX: số (dấu phẩy hoặc chấm thập phân), ngày, chuỗi "NULL".
 */
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

/** "", "NULL", null, undefined → true */
export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" || s.toUpperCase() === "NULL";
  }
  return false;
}

export function toText(v: unknown): string | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return formatDateTime(v);
  return String(v).trim();
}

/**
 * Parse số từ text:
 *  - "8,35" → 8.35 (dấu phẩy thập phân, như file export từ Google Sheet locale VN)
 *  - "1.234,56" → 1234.56 ; "1,234.56" → 1234.56
 *  - "$ 12.5", "(3,20)" → 12.5, -3.2
 */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (isBlank(v)) return null;
  let s = String(v).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d,.\-]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s === "") return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Ký tự xuất hiện sau cùng là dấu thập phân
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const commas = s.split(",").length - 1;
    s = commas > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    const dots = s.split(".").length - 1;
    if (dots > 1) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const DATE_FORMATS = [
  "M/D/YYYY",
  "M/D/YYYY H:mm:ss",
  "M/D/YYYY H:mm",
  "M-D-YYYY",
  "M-D-YYYY H:mm:ss",
  "M-D-YYYY H:mm",
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DDTHH:mm:ss",
  "YYYY/MM/DD",
];

/** Date do exceljs trả về là giờ "tường" lưu dưới dạng UTC → đọc bằng UTC getters. */
function fromExcelDate(d: Date) {
  return dayjs(
    new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()),
  );
}

/** Serial Excel → dayjs (25569 = 1970-01-01 tính theo mốc 1899-12-30 của Excel) */
function fromExcelSerial(serial: number) {
  return fromExcelDate(new Date(Math.round((serial - 25569) * 86400 * 1000)));
}

/**
 * Ô ngày xuất ra .csv từ sheet không định dạng ngày cho chuỗi toàn số (VD "46023.43107").
 * 5–6 chữ số = serial Excel (1927–4637), không đụng năm 4 chữ số nên không mơ hồ với "2025".
 * Thiếu nhánh này thì `dayjs("46023.43107")` fallback lỏng ra **năm 4602** mà không báo lỗi.
 */
const EXCEL_SERIAL = /^\d{5,6}(\.\d+)?$/;

function toDayjs(v: unknown): dayjs.Dayjs | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : fromExcelDate(v);
  if (typeof v === "number") return fromExcelSerial(v);
  const s = String(v).trim();
  if (EXCEL_SERIAL.test(s)) return fromExcelSerial(Number(s));
  const d = dayjs(s, DATE_FORMATS, true);
  if (d.isValid()) return d;
  const iso = dayjs(s);
  return iso.isValid() && /\d{4}/.test(s) ? iso : null;
}

/** → "YYYY-MM-DD" hoặc null */
export function parseDate(v: unknown): string | null {
  const d = toDayjs(v);
  return d ? d.format("YYYY-MM-DD") : null;
}

/** → "YYYY-MM-DD HH:mm:ss" hoặc null */
export function parseDateTime(v: unknown): string | null {
  const d = toDayjs(v);
  return d ? d.format("YYYY-MM-DD HH:mm:ss") : null;
}

/**
 * Ô chỉ chứa giờ trong ngày → "HH:mm:ss".
 * .xlsx lưu kiểu này thành Date năm 1899 (exceljs) hoặc số thập phân phần của ngày (0.2295 = 05:30:40).
 */
export function parseTimeOfDay(v: unknown): string | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatDateTime(v).slice(-8);
  if (typeof v === "number" && v >= 0 && v < 1) {
    const total = Math.round(v * 86400);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  }
  const s = String(v).trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
  return s || null;
}

export function formatDateTime(d: Date): string {
  const x = fromExcelDate(d);
  if (d.getUTCFullYear() < 1900) return x.format("HH:mm:ss"); // ô chỉ có giờ
  if (x.hour() === 0 && x.minute() === 0 && x.second() === 0) return x.format("YYYY-MM-DD");
  return x.format("YYYY-MM-DD HH:mm:ss");
}

export function toFlag(v: unknown, fallback = 0): number {
  if (isBlank(v)) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "x"].includes(s)) return 1;
  if (["0", "false", "no", "n"].includes(s)) return 0;
  const n = parseNumber(v);
  return n === null ? fallback : n !== 0 ? 1 : 0;
}

export function nowIso(): string {
  return dayjs().format("YYYY-MM-DD HH:mm:ss");
}
