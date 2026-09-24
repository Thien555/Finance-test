import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { buildOrderEvents } from "@/lib/engine/build-orders";
import { classifyOf, postEvents } from "@/lib/engine/post";
import type { JournalLineRuleRow } from "@/lib/db/schema";
import { loadIndex, loadMasters, loadSampleOrders, toEventRows } from "../helpers/fixtures";

const sum = (xs: number[]) => xs.reduce((a, b) => a.plus(b), new Decimal(0)).toNumber();

describe("Post Bulk trên event build từ toàn bộ file order thật", async () => {
  const index = loadIndex();
  const build = buildOrderEvents(await loadSampleOrders(), index);
  // Giống runPost: chỉ post event NEW, bỏ 2.388 event ERROR từ bước Build (seller ngoài Partners)
  const events = toEventRows(build.events).filter((e) => e.PostStatus === "NEW");
  const result = postEvents(events, "Bulk", index);
  const gl = result.glLines;

  it("toàn bộ JournalType ORDERS là Bulk", () => {
    expect(events.every((e) => classifyOf(index, e) === "Bulk")).toBe(true);
  });

  it("3.397 chứng từ → 6.794 dòng GLTrans, 153.845 event POSTED", () => {
    expect(result.docCount).toBe(3_397);
    expect(gl).toHaveLength(6_794);
    expect(result.posted).toHaveLength(153_845);
    expect(result.failed).toHaveLength(0);
    expect(events).toHaveLength(result.posted.length);
  });

  it("tổng Nợ = tổng Có = 4.013.848,04", () => {
    expect(sum(gl.map((l) => l.AccountedDr ?? 0))).toBe(4_013_848.04);
    expect(sum(gl.map((l) => l.AccountedCr ?? 0))).toBe(4_013_848.04);
    expect(sum(gl.map((l) => l.InputDr ?? 0))).toBe(4_013_848.04);
  });

  it("group ngày 20/11/2025 đúng số tiền và bút toán", () => {
    const day = gl.filter((l) => l.TransDate === "2025-11-20");
    const line = (account: string, side: "Debit" | "Credit", jtc: string, partner?: string) =>
      day.find(
        (l) =>
          l.AccountCode === account && l.BalanceImpact === side && l.JournalTypeCode === jtc && (!partner || l.PartnerCode === partner),
      );

    expect(line("13122001", "Debit", "ORD_REV_PRODUCT_FULFILLED")?.InputDr).toBe(2230.66);
    expect(line("51112001", "Credit", "ORD_REV_PRODUCT_FULFILLED")?.InputCr).toBe(2230.66);
    expect(line("51131001", "Credit", "ORD_REV_SHIPADD_FULFILLED")?.InputCr).toBe(164.67);
    expect(line("63202001", "Debit", "ORD_SELLER_PROFIT_FULFILLED", "cong2672000@gmail.com")?.InputDr).toBe(397.04);
    expect(line("33102001", "Credit", "ORD_SELLER_PROFIT_FULFILLED", "cong2672000@gmail.com")?.InputCr).toBe(397.04);
    expect(line("33102001", "Credit", "ORD_SELLER_PROFIT_FULFILLED", "lyndylutz@gmail.com")?.InputCr).toBe(145);
    expect(line("33102001", "Credit", "ORD_SELLER_PROFIT_FULFILLED", "nguyenthang5356@gmail.com")?.InputCr).toBe(1027.68);
  });

  it("DocNum / PostingGroupKey theo format sample", () => {
    const l = gl.find((x) => x.PartnerCode === "cong2672000@gmail.com" && x.TransDate === "2025-11-20")!;
    expect(l.PostingGroupKey).toBe("ZENIROXPAY|ORD_SELLER_PROFIT_FULFILLED|20251120|USD|USD|CONG2672000@GMAIL.COM|VA4ZH4IIFMUTCFCXF1GY|");
    const groupEvents = events.filter(
      (e) => e.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED" && e.PartnerCode === "cong2672000@gmail.com" && e.PostingDate === "2025-11-20",
    );
    const minId = Math.min(...groupEvents.map((e) => e.AccountingEventID));
    expect(l.DocNum).toBe(`ASB-20251120-${minId}`);
    expect(l).toMatchObject({ ComCode: "ZENIROXPAY", Period: "202511", XRate: 1, RateType: "MUL", PartnerTaxID: "VA4ZH4IIFMUTCFCXF1GY" });
    expect(groupEvents).toHaveLength(11);
    expect(l.Description).toBe(`Orders Fulfilled Seller Profit Bulk | CONTRA_TRANS | ${groupEvents.length} events`);
  });
});

describe("Post Single + NegativeMode + FX (dữ liệu giả)", async () => {
  const masters = loadMasters();
  // Neo vào 1 đơn fulfilled cụ thể thay vì vị trí dòng — file thật có dòng đầu UNFULFILLED
  const anchor = (await loadSampleOrders()).filter((r) => r.OrderId === "MTUBV-181125-51MRR");
  const base = toEventRows(buildOrderEvents(anchor, loadIndex()).events)[0];

  /** Tạo 1 JournalType Single + 1 rule tùy biến để test */
  function setup(rule: Partial<JournalLineRuleRow>) {
    const index = loadIndex({
      journalTypes: [
        ...masters.journalTypes,
        { JournalTypeID: 999, DataSource: "TEST", JournalType: "Test", JournalTypeCode: "TEST_JT", BankAccount: "11202051", ContraAccount: "13122001", TransAccount: "51112001", FeeAccount: "64202010", Partner: "Fixed = PAYPAL", Classify: "Single", GroupRule: null },
      ],
      lineRules: [
        ...masters.lineRules,
        { JournalLineRuleID: 999, JournalTypeCode: "TEST_JT", RuleSeq: 10, PairCode: "BANK_CONTRA", NormalDrAccountSource: "BANK_ACCOUNT", NormalCrAccountSource: "CONTRA_ACCOUNT", AmountSource: "GROSS", AmountFactor: 1, ReverseIfNegative: 0, SkipIfDrAccountNull: 1, SkipIfCrAccountNull: 1, SkipIfAmountZero: 1, PartnerMode: "HEADER", FixedPartner: null, ApplyPartnerToDrLine: 1, ApplyPartnerToCrLine: 1, MemoTemplate: "Pair 1: Bank vs Contra from Gross", IsActive: 1, NegativeMode: "SIGNED", ...rule },
      ],
    });
    const event = (patch: object) => ({
      ...base,
      AccountingEventID: 24814293,
      DataSource: "TEST",
      JournalTypeCode: "TEST_JT",
      EventSeq: 10,
      TransactionID: "20B12830VH832350H",
      PostingDate: "2025-02-03",
      Period: "202502",
      BankGLAccount: "11202051",
      ContraAccount: "13122001",
      TransAccount: "51112001",
      FeeAccount: "64202010",
      BankAccountNumber: "PAYPAL1",
      PartnerCode: "PAYPAL",
      PartnerTaxID: null,
      ...patch,
    });
    return { index, event };
  }

  it("Single: 1 event → 2 dòng, DocNum ASI-yyyyMMdd-EventID", () => {
    const { index, event } = setup({});
    const r = postEvents([event({ Amount: 39.98 })], "Single", index);
    expect(r.glLines.map((l) => [l.DocNum, l.AccountCode, l.BalanceImpact, l.InputDr, l.InputCr])).toEqual([
      ["ASI-20250203-24814293", "11202051", "Debit", 39.98, 0],
      ["ASI-20250203-24814293", "13122001", "Credit", 0, 39.98],
    ]);
    expect(r.glLines[0]).toMatchObject({ ReferenceTxnID: "20B12830VH832350H", PostingGroupKey: null, BankAccountNumber: "PAYPAL1", Description: "Pair 1: Bank vs Contra from Gross | 20B12830VH832350H" });
  });

  it("REVERSE: amount âm → đảo Nợ/Có, lấy trị tuyệt đối (giống sample PP_CHARGEBACK)", () => {
    const { index, event } = setup({ NegativeMode: "REVERSE" });
    const r = postEvents([event({ Amount: -39.98 })], "Single", index);
    expect(r.glLines.map((l) => [l.AccountCode, l.BalanceImpact, l.InputDr, l.InputCr])).toEqual([
      ["13122001", "Debit", 39.98, 0],
      ["11202051", "Credit", 0, 39.98],
    ]);
  });

  it("SIGNED: amount âm giữ dấu trên cả 2 vế", () => {
    const { index, event } = setup({ NegativeMode: "SIGNED" });
    const r = postEvents([event({ Amount: -23.19 })], "Single", index);
    expect(r.glLines.map((l) => [l.AccountCode, l.InputDr, l.InputCr])).toEqual([
      ["11202051", -23.19, 0],
      ["13122001", 0, -23.19],
    ]);
  });

  it("ERROR: amount âm → event lỗi, không sinh GL", () => {
    const { index, event } = setup({ NegativeMode: "ERROR" });
    const r = postEvents([event({ Amount: -5 })], "Single", index);
    expect(r.glLines).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect(r.exceptions[0].ExceptionType).toBe("NEGATIVE_AMOUNT");
  });

  it("FX DIV: CAD → USD kỳ 202501 rate 1.439", () => {
    const { index, event } = setup({});
    const r = postEvents([event({ Amount: 143.9, InputCurr: "CAD", FncCurr: "USD", Period: "202501", PostingDate: "2025-01-15" })], "Single", index);
    expect(r.glLines[0]).toMatchObject({ InputDr: 143.9, XRate: 1.439, RateType: "DIV", AccountedDr: 100 });
  });

  it("thiếu tỷ giá → MISSING_FX", () => {
    const { index, event } = setup({});
    const r = postEvents([event({ Amount: 10, InputCurr: "EUR" })], "Single", index);
    expect(r.failed).toHaveLength(1);
    expect(r.exceptions[0].ExceptionType).toBe("MISSING_FX");
  });

  it("PartnerMode FIXED + AmountFactor -1 (giống rule FEE_BANK của PayPal)", () => {
    const { index, event } = setup({ PartnerMode: "FIXED", FixedPartner: "PAYPAL", AmountFactor: -1, NegativeMode: "REVERSE", NormalDrAccountSource: "FEE_ACCOUNT", NormalCrAccountSource: "BANK_ACCOUNT" });
    const r = postEvents([event({ Amount: 2.5, PartnerCode: "someone@x.com" })], "Single", index);
    // 2.5 × -1 = -2.5 → REVERSE: Nợ Bank / Có Fee 2.5
    expect(r.glLines.map((l) => [l.AccountCode, l.BalanceImpact, l.PartnerCode, l.InputDr, l.InputCr])).toEqual([
      ["11202051", "Debit", "PAYPAL", 2.5, 0],
      ["64202010", "Credit", "PAYPAL", 0, 2.5],
    ]);
  });
});
