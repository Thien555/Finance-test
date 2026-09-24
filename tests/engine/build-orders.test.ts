import { describe, expect, it } from "vitest";
import { buildOrderEvents } from "@/lib/engine/build-orders";
import { loadIndex, loadMasters, loadSampleOrders } from "../helpers/fixtures";

describe("Build Orders trên toàn bộ file order thật", async () => {
  const rows = await loadSampleOrders();
  const index = loadIndex();
  const result = buildOrderEvents(rows, index);
  const byJtc = (jtc: string) => result.events.filter((e) => e.JournalTypeCode === jtc);
  const exOf = (type: string) => result.exceptions.filter((e) => e.ExceptionType === type);

  it("đọc 55.111 dòng (1 dòng thiếu OrderId bị loại), 52.437 FULFILLED / 2.674 bị skip", () => {
    expect(rows).toHaveLength(55_111);
    expect(result.stats.fulfilledRows).toBe(52_437);
    expect(result.stats.skippedRows).toBe(2_674);
    // Mỗi dòng không fulfill sinh đúng 1 exception NOT_FULFILLED
    expect(exOf("NOT_FULFILLED")).toHaveLength(result.stats.skippedRows);
    expect(result.stats.fulfilledRows + result.stats.skippedRows).toBe(rows.length);
  });

  it("156.233 event = 52.437 PRODUCT + 51.309 SHIPADD + 183 TAX + 52.304 SELLER_PROFIT", () => {
    expect(result.events).toHaveLength(156_233);
    expect(byJtc("ORD_REV_PRODUCT_FULFILLED")).toHaveLength(52_437);
    expect(byJtc("ORD_REV_SHIPADD_FULFILLED")).toHaveLength(51_309);
    expect(byJtc("ORD_REV_TAX_FULFILLED")).toHaveLength(183);
    expect(byJtc("ORD_SELLER_PROFIT_FULFILLED")).toHaveLength(52_304);
    // PRODUCT sinh đúng 1 event cho mỗi dòng fulfilled; các loại khác bị bỏ khi số tiền = 0
    expect(byJtc("ORD_REV_PRODUCT_FULFILLED")).toHaveLength(result.stats.fulfilledRows);
  });

  it("2.388 seller ngoài Partners → event ERROR; không dòng nào thiếu ComCode", () => {
    // Dòng duy nhất có gateway lạ ("Zenirox Pay SPF-BDU") lại UNFULFILLED nên bị skip trước khi resolve ComCode
    expect(exOf("MISSING_COMCODE")).toHaveLength(0);
    const failed = result.events.filter((e) => e.PostStatus === "ERROR");
    expect(failed).toHaveLength(2_388);
    expect(failed.every((e) => e.ErrorStage === "BUILD" && e.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED")).toBe(true);
    expect(exOf("MISSING_PARTNER")).toHaveLength(failed.length);
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

  it("không dòng nào rơi vào kỳ vô lý (serial Excel đọc nhầm thành năm 4602)", () => {
    const periods = [...new Set(result.events.map((e) => e.Period))].sort();
    expect(periods[0] >= "202511" && periods[periods.length - 1] <= "202612").toBe(true);
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
