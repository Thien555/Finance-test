import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseDate, parseDateTime, parseNumber } from "@/lib/engine/parse";
import { readTable } from "@/lib/io/read-table";
import { parseJournalTypes } from "@/lib/master/parse-master";
import { ORDER_COLUMNS } from "@/lib/orders/columns";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";
import { loadMasters, loadOrderRecords, TEST_GATEWAY_MAPPINGS } from "../helpers/fixtures";

describe("parseNumber", () => {
  it.each([
    ["8,35", 8.35],
    ["1,439", 1.439],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["$ 12.5", 12.5],
    ["(3,20)", -3.2],
    ["-23,19", -23.19],
    ["26500", 26500],
    [19, 19],
  ])("%s → %s", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it("blank / NULL → null", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("NULL")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });
});

describe("parseDate", () => {
  it("các format trong file order", () => {
    expect(parseDate("11/24/2025")).toBe("2025-11-24");
    expect(parseDate("11-19-2025")).toBe("2025-11-19");
    expect(parseDateTime("11-19-2025 5:46:05")).toBe("2025-11-19 05:46:05");
    expect(parseDate(new Date(Date.UTC(2025, 10, 24)))).toBe("2025-11-24");
    expect(parseDate("")).toBeNull();
  });

  // Ô ngày trong sheet không định dạng ngày xuất ra .csv thành serial Excel dạng chuỗi.
  // Trước đây rơi vào fallback lỏng của dayjs → "46023.43107" ra năm 4602 mà không báo lỗi.
  it("chuỗi serial Excel ra đúng ngày, không ra năm 4602", () => {
    expect(parseDate("46023.43107")).toBe("2026-01-01");
    expect(parseDateTime("46023.43107")).toBe("2026-01-01 10:20:44");
    expect(parseDate("46024.12545")).toBe("2026-01-02");
    expect(parseDate("45978")).toBe("2025-11-17");
    expect(parseDate(45978)).toBe(parseDate("45978"));
  });

  it("năm 4 chữ số vẫn là năm, không bị hiểu thành serial", () => {
    expect(parseDate("2025-11-24")).toBe("2025-11-24");
    expect(parseDate("2025")).toBe("2025-01-01");
  });
});

describe("master data", () => {
  it("JournalType lấy ContraAccount theo vị trí cột (header sheet ghi nhầm 11202052)", () => {
    const text = "JournalTypeID,DataSource,JournalType,JournalTypeCode,BankAccount,11202052,TransAccount,FeeAccount,Partner,Classify\n36,ORDERS,X,ORD_SELLER_PROFIT_FULFILLED,NULL,33102001,63202001,NULL,From Source,Bulk";
    const [jt] = parseJournalTypes(text);
    expect(jt.ContraAccount).toBe("33102001");
    expect(jt.BankAccount).toBeNull();
  });

  it("load đủ snapshot", () => {
    const m = loadMasters();
    expect(m.partners.length).toBeGreaterThan(1900);
    expect(m.journalTypes.filter((j) => j.DataSource === "ORDERS")).toHaveLength(4);
    expect(m.lineRules.length).toBeGreaterThan(100);
    expect(m.exrates.find((e) => e.ExrateID === 1)?.Exrate).toBe(1.439);
  });
});

describe("file order thật", () => {
  it("đúng 55.112 dòng, 1 dòng hỏng, 46 cột", async () => {
    const { headers, records } = await loadOrderRecords();
    expect(records).toHaveLength(55_112);
    expect(headers).toEqual(ORDER_COLUMNS.map(([name]) => name));

    const { map } = canonicalHeaders(headers);
    const bad = records.map((r, i) => ({ row: i + 2, r: normalizeOrderRow(r, map) })).filter((x) => !x.r.ok);
    expect(bad.map((b) => [b.row, (b.r as { error: string }).error])).toEqual([[27_342, "Thiếu OrderId"]]);
  });

  it("mọi cổng thanh toán trong file đều có mapping (trừ 2 giá trị lỗi đã biết)", async () => {
    const { records } = await loadOrderRecords();
    const mapped = new Set(TEST_GATEWAY_MAPPINGS.map((m) => m.PaymentGatewayName.trim().toUpperCase()));
    const missing = [...new Set(records.map((r) => (r.PaymentGatewayName ?? "").trim()))].filter((g) => !mapped.has(g.toUpperCase()));
    // Đổi file mẫu mà thêm cổng mới sẽ fail ở đây thay vì âm thầm làm lệch mọi baseline
    expect(missing.sort()).toEqual(["", "Zenirox Pay SPF-BDU"]);
  });

  // File .xlsx mẫu không còn; dựng workbook trong bộ nhớ để vẫn khóa được tính tương đương 2 đường đọc
  // (readXlsx trả Date object, readCsv trả chuỗi — parse.ts phải cho ra cùng kết quả).
  it("đọc .xlsx và .csv cho cùng kết quả", async () => {
    const { headers, records } = await loadOrderRecords();
    const sample = records.slice(0, 200);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Orders");
    ws.addRow(headers);
    for (const r of sample) ws.addRow(headers.map((h) => r[h] ?? null));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const fromXlsx = await readTable(buffer, "orders.xlsx", "OrderId");
    const { map } = canonicalHeaders(headers);
    const pick = (rs: Record<string, unknown>[]) =>
      rs.map((r) => {
        const n = normalizeOrderRow(r, map);
        if (!n.ok) throw new Error(n.error);
        const { ItemCode, ItemStatus, FulfilledAt, Quantity, UnitPrice, ShippingFee, Profit, TaxFee, PaymentGatewayName } = n.row;
        return [ItemCode, ItemStatus, FulfilledAt, Quantity, UnitPrice, ShippingFee, Profit, TaxFee, PaymentGatewayName];
      });
    expect(pick(fromXlsx.records)).toEqual(pick(sample));
  });
});
