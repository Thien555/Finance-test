import { describe, expect, it } from "vitest";
import { buildOrderEvents } from "@/lib/engine/build-orders";
import { loadIndex, loadMasters, loadSampleOrders } from "../helpers/fixtures";

describe("Build Orders trên 64 dòng order mẫu", async () => {
  const rows = await loadSampleOrders();
  const index = loadIndex();
  const result = buildOrderEvents(rows, index);
  const byJtc = (jtc: string) => result.events.filter((e) => e.JournalTypeCode === jtc);

  it("60 dòng FULFILLED được build, 4 UNFULFILLED bị skip", () => {
    expect(result.stats.fulfilledRows).toBe(60);
    expect(result.stats.skippedRows).toBe(4);
    expect(result.exceptions.filter((e) => e.ExceptionType === "NOT_FULFILLED")).toHaveLength(4);
  });

  it("174 event = 60 PRODUCT + 58 SHIPADD + 56 SELLER_PROFIT, TAX = 0", () => {
    expect(result.events).toHaveLength(174);
    expect(byJtc("ORD_REV_PRODUCT_FULFILLED")).toHaveLength(60);
    expect(byJtc("ORD_REV_SHIPADD_FULFILLED")).toHaveLength(58);
    expect(byJtc("ORD_REV_TAX_FULFILLED")).toHaveLength(0);
    expect(byJtc("ORD_SELLER_PROFIT_FULFILLED")).toHaveLength(56);
  });

  it("tất cả seller đều match Partners, cả 2 gateway map về ZENIROXPAY", () => {
    expect(result.events.every((e) => e.PostStatus === "NEW")).toBe(true);
    expect(new Set(result.events.map((e) => e.ComCode))).toEqual(new Set(["ZENIROXPAY"]));
  });

  it("event của order MTUBV-181125-51MRR khớp format sample AccountingEvent", () => {
    const events = result.events.filter((e) => e.OrderID === "MTUBV-181125-51MRR");
    expect(events.map((e) => [e.JournalTypeCode, e.Amount])).toEqual([
      ["ORD_REV_PRODUCT_FULFILLED", 34.99],
      ["ORD_REV_SHIPADD_FULFILLED", 4.99],
      ["ORD_SELLER_PROFIT_FULFILLED", 28.42],
    ]);
    const profit = events[2];
    expect(profit).toMatchObject({
      TransactionID: "ORD-MTUBV-181125-51MRR-20251120",
      SourceID: "MTUBV-181125-51MRR|20251120",
      EventSeq: 20,
      PairCode: "CONTRA_TRANS",
      AmountSource: "SELLER_PROFIT",
      PostingDate: "2025-11-20",
      Period: "202511",
      InputCurr: "USD",
      FncCurr: "USD",
      ContraAccount: "33102001",
      TransAccount: "63202001",
      PartnerCode: "cong2672000@gmail.com",
      PartnerTaxID: "VA4ZH4IIFMUTCFCXF1GY",
      PartnerName: "FFT-FFT ARG",
      Description: "Orders Fulfilled Seller Profit",
    });
    expect(events[0]).toMatchObject({ PartnerCode: "INDIVIDUALS", ContraAccount: "13122001", TransAccount: "51112001" });
  });

  it("seller không có trong Partners → event ERROR + exception MISSING_PARTNER", () => {
    const row = { ...rows.find((r) => r.OrderId === "MTUBV-181125-51MRR")!, SellerEmail: "khong-ton-tai@example.com" };
    const r = buildOrderEvents([row], index);
    const profit = r.events.find((e) => e.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED")!;
    expect(profit.PostStatus).toBe("ERROR");
    expect(profit.ErrorStage).toBe("BUILD");
    expect(r.exceptions.some((e) => e.ExceptionType === "MISSING_PARTNER")).toBe(true);
  });

  it("gateway chưa map → MISSING_COMCODE, không sinh event", () => {
    const row = { ...rows[1], PaymentGatewayName: "Unknown Pay" };
    const r = buildOrderEvents([row], index);
    expect(r.events).toHaveLength(0);
    expect(r.exceptions[0].ExceptionType).toBe("MISSING_COMCODE");
  });

  it("1 order nhiều item cùng ngày fulfill được cộng dồn thành 1 event", () => {
    const base = rows.find((r) => r.OrderId === "MTUBV-181125-51MRR")!;
    const items = [
      { ...base, RawOrderID: 1, ItemCode: "A-1", Quantity: 2, UnitPrice: 10, ShippingFee: 1, AdditionalCost: 0.5, Profit: 3 },
      { ...base, RawOrderID: 2, ItemCode: "A-2", Quantity: 1, UnitPrice: 5.55, ShippingFee: 0, AdditionalCost: 0, Profit: 1.1 },
    ];
    const r = buildOrderEvents(items, loadIndex({ ...loadMasters() }));
    expect(r.events.map((e) => [e.JournalTypeCode, e.Amount, e.rawRowIds])).toEqual([
      ["ORD_REV_PRODUCT_FULFILLED", 25.55, [1, 2]],
      ["ORD_REV_SHIPADD_FULFILLED", 1.5, [1, 2]],
      ["ORD_SELLER_PROFIT_FULFILLED", 4.1, [1, 2]],
    ]);
  });
});
