import { describe, expect, it } from "vitest";
import { parseDate, parseDateTime, parseNumber } from "@/lib/engine/parse";
import { parseJournalTypes } from "@/lib/master/parse-master";
import { loadMasters, loadSampleOrders } from "../helpers/fixtures";

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

describe("file order mẫu", () => {
  it("CSV và XLSX cho cùng kết quả", async () => {
    const csv = await loadSampleOrders("orders-sample.csv");
    const xlsx = await loadSampleOrders("orders-sample.xlsx");
    expect(csv).toHaveLength(64);
    expect(xlsx).toHaveLength(64);
    const pick = (r: (typeof csv)[number]) => [r.ItemCode, r.ItemStatus, r.FulfilledAt, r.Quantity, r.UnitPrice, r.ShippingFee, r.Profit, r.TaxFee, r.PaymentGatewayName];
    expect(xlsx.map(pick)).toEqual(csv.map(pick));
  });
});
