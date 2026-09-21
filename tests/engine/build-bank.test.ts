import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { amountFromSource, type BankSourceSpec, buildBankEvents } from "@/lib/engine/build-bank";
import { classifyOf, postEvents } from "@/lib/engine/post";
import { accountingSourceSpec } from "@/lib/engine/sources/accounting-source";
import { paypalSpec, PAYPAL_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/paypal";
import { pipoAmountExcludesFee, pipoSpec, PIPO_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/pipo";
import { stripeSpec, STRIPE_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/stripe";
import { signedAmount } from "@/lib/sources/normalize";
import {
  loadIndex,
  loadSampleAccountingSource,
  loadSamplePaypal,
  loadSamplePipo,
  loadSampleStripe,
  toEventRows,
} from "../helpers/fixtures";

const index = loadIndex();

/** Build rồi post cả Single lẫn Bulk, trả tổng Nợ/Có để kiểm cân đối */
function buildAndPost<R>(rows: R[], spec: BankSourceSpec<R>) {
  const built = buildBankEvents(rows, spec, index);
  const eventRows = toEventRows(built.events, 1000);
  const noClassify = eventRows.filter((e) => classifyOf(index, e) === null);
  const posted = (["Single", "Bulk"] as const).map((classify) => {
    const candidates = eventRows.filter((e) => classifyOf(index, e) === classify);
    return { classify, candidates: candidates.length, result: candidates.length ? postEvents(candidates, classify, index) : null };
  });
  const glLines = posted.flatMap((p) => p.result?.glLines ?? []);
  const sum = (pick: (l: (typeof glLines)[number]) => number | null) =>
    glLines.reduce((s, l) => s.plus(pick(l) ?? 0), new Decimal(0)).toDecimalPlaces(2).toNumber();
  return {
    built,
    posted,
    glLines,
    noClassify,
    totalDr: sum((l) => l.AccountedDr ?? null),
    totalCr: sum((l) => l.AccountedCr ?? null),
    failed: posted.flatMap((p) => p.result?.failed ?? []),
  };
}

describe("amountFromSource", () => {
  it("chỉ nhận AMOUNT/GROSS/FEE/NET, nguồn không khai thì trả undefined để báo UNKNOWN_AMOUNT_SOURCE", () => {
    const amounts = { GROSS: new Decimal(10), FEE: new Decimal(-1) };
    expect(amountFromSource("GROSS", amounts)?.toNumber()).toBe(10);
    expect(amountFromSource("fee", amounts)?.toNumber()).toBe(-1);
    expect(amountFromSource("AMOUNT", amounts)).toBeUndefined();
    expect(amountFromSource("PRODUCT", amounts)).toBeUndefined();
    expect(amountFromSource(null, amounts)).toBeUndefined();
  });
});

describe("signedAmount (BalanceImpact → dấu)", () => {
  it("Debit = tiền ra → âm; Credit = tiền vào → dương; luôn lấy trị tuyệt đối của Amount", () => {
    expect(signedAmount(6, "Debit")).toBe(-6);
    expect(signedAmount(6, "Credit")).toBe(6);
    expect(signedAmount(-6, "Debit")).toBe(-6);
    expect(signedAmount(-6, "Credit")).toBe(6);
    expect(signedAmount(6, null)).toBe(6);
    expect(signedAmount(null, "Debit")).toBeNull();
  });
});

describe("Build PayPal", () => {
  it("sinh event theo rule, bỏ rule thiếu TransAccount / fee = 0", async () => {
    const rows = await loadSamplePaypal();
    const r = buildBankEvents(rows, paypalSpec, index);

    expect(r.stats.sourceRows).toBe(81);
    expect(r.stats.skippedRows).toBe(0);
    // 1 dòng "General Currency Conversion": master chỉ có PP_USER_INITIATED_CURRENCY_CONVERSION
    expect(r.stats.errorRows).toBe(1);
    expect(r.exceptions.filter((e) => e.ExceptionType === "MISSING_JOURNAL_TYPE").map((e) => e.SourceKey)).toEqual([
      "PP_GENERAL_CURRENCY_CONVERSION",
    ]);

    // Hold/Release: Contra = 11202052, TransAccount NULL → chỉ còn rule 10
    const hold = r.events.filter((e) => e.JournalTypeCode === "PP_RESERVE_HOLD");
    expect(hold.map((e) => e.EventSeq)).toEqual([10, 10, 10, 10]);
    expect(hold[0].BankGLAccount).toBe("11202051");
    expect(hold[0].ContraAccount).toBe("11202052");
    expect(hold[0].BankAccountNumber).toBe(PAYPAL_DEFAULT_BANK_ACCOUNT);
    expect(hold.every((e) => e.Amount < 0)).toBe(true); // Reserve Hold là tiền bị giữ lại

    // Thanh toán: rule 10 (GROSS) + rule 30 (FEE), không có rule 20
    const checkout = r.events.filter((e) => e.JournalTypeCode === "PP_EXPRESS_CHECKOUT_PAYMENT");
    expect([...new Set(checkout.map((e) => e.EventSeq))].sort()).toEqual([10, 30]);
    const fee = checkout.find((e) => e.EventSeq === 30)!;
    // Fee trên file mang dấu âm, Build giữ nguyên dấu — AmountFactor -1 được áp ở bước Post
    expect(fee.Amount).toBeLessThan(0);
    expect(fee.AmountSource).toBe("FEE");
  });

  it("partner Fixed lấy từ JournalType, From Source lấy cột PartnerCode", async () => {
    const rows = await loadSamplePaypal();
    const r = buildBankEvents(rows, paypalSpec, index);

    // PP_RESERVE_HOLD: "Fixed = Reserve Hold" → partner cố định dù cột PartnerCode trống
    expect(r.events.find((e) => e.JournalTypeCode === "PP_RESERVE_HOLD")?.PartnerCode).toBe("RESERVE HOLD");
    // PP_EXPRESS_CHECKOUT_PAYMENT: "Fixed = Individuals"
    expect(r.events.find((e) => e.JournalTypeCode === "PP_EXPRESS_CHECKOUT_PAYMENT")?.PartnerCode).toBe("INDIVIDUALS");
    // PP_MASS_PAY_PAYMENT: "From Source" nhưng file để trống → cảnh báo, không chặn
    const warn = r.exceptions.find((e) => e.ExceptionType === "MISSING_PARTNER" && e.SourceKey?.startsWith("PP_MASS_PAY_PAYMENT"));
    expect(warn?.Severity).toBe("WARNING");
  });

  it("post ra chứng từ cân và đúng định dạng của sheet mẫu GLTrans", async () => {
    const rows = await loadSamplePaypal();
    const { built, glLines, totalDr, totalCr, failed, noClassify } = buildAndPost(rows, paypalSpec);

    expect(built.stats.events).toBe(113);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);

    const single = glLines.find((l) => l.DocNum.startsWith("ASI-"))!;
    expect(single.BankAccountNumber).toBe(PAYPAL_DEFAULT_BANK_ACCOUNT);
    // gltrans-reference.csv: Description = "{MemoTemplate} | {TransactionID}", ReferenceTxnID = mã giao dịch PayPal
    expect(single.Description).toBe(`${single.Description?.split(" | ")[0]} | ${single.ReferenceTxnID}`);
    expect(single.ReferenceTxnID).not.toContain("|"); // mã gốc, không phải SourceKey
    expect(glLines.some((l) => l.DocNum.startsWith("ASB-"))).toBe(true);
  });
});

describe("Build Stripe", () => {
  it("nhận Currency 'usd' chữ thường và map charge → STRIPE_RECEIPT_CUSTOMER", async () => {
    const rows = await loadSampleStripe();
    expect(rows.every((r) => r.Currency === "USD")).toBe(true);

    const r = buildBankEvents(rows, stripeSpec, index);
    expect(r.stats.skippedRows).toBe(0);
    expect(r.stats.errorRows).toBe(0);

    const charge = r.events.filter((e) => e.JournalTypeCode === "STRIPE_RECEIPT_CUSTOMER");
    expect(charge.length).toBeGreaterThan(0);
    expect(charge[0].BankGLAccount).toBe("11202081");
    expect(charge[0].BankAccountNumber).toBe(STRIPE_DEFAULT_BANK_ACCOUNT);
    expect(charge[0].PartnerCode).toBe("INDIVIDUALS");
    // Fee của Stripe mang dấu dương (ngược PayPal) và AmountFactor = 1
    expect(charge.find((e) => e.EventSeq === 30)!.Amount).toBeGreaterThan(0);
  });

  it("dòng reserved_funds bỏ trống JournalType được suy ra từ cột Type → STRIPE_RESERVE (TK 11202082)", async () => {
    const rows = await loadSampleStripe();
    expect(rows.some((r) => r.Type === "reserved_funds" && !r.JournalType)).toBe(true);

    const r = buildBankEvents(rows, stripeSpec, index);
    const reserve = r.events.filter((e) => e.JournalTypeCode === "STRIPE_RESERVE");
    expect(reserve.length).toBeGreaterThan(0);
    expect(reserve[0].ContraAccount).toBe("11202082");
    expect(r.exceptions.some((e) => e.ExceptionType === "MISSING_JOURNAL_TYPE")).toBe(false);
  });

  it("post ra chứng từ cân", async () => {
    const { built, totalDr, totalCr, failed, noClassify } = buildAndPost(await loadSampleStripe(), stripeSpec);
    expect(built.stats.events).toBe(71);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);
  });
});

describe("Build PIPO", () => {
  it("bỏ dòng Status ≠ Success", async () => {
    const rows = await loadSamplePipo();
    const r = buildBankEvents(rows, pipoSpec, index);
    expect(r.stats.skippedRows).toBe(2);
    const skip = r.exceptions.find((e) => e.ExceptionType === "SOURCE_ROW_SKIPPED");
    expect(skip?.Severity).toBe("INFO");
    expect(skip?.Message).toContain("Retrieved");
  });

  it("dùng JournalType của DataSource = PIPO (TK ngân hàng PingPong 11202061)", async () => {
    const r = buildBankEvents(await loadSamplePipo(), pipoSpec, index);
    const seller = r.events.find((e) => e.JournalTypeCode === "BANK_PAYMENT_SELLER")!;
    expect(seller.DataSource).toBe("PIPO");
    expect(seller.BankGLAccount).toBe("11202061");
    expect(seller.BankAccountNumber).toBe(PIPO_DEFAULT_BANK_ACCOUNT);
    expect(seller.ContraAccount).toBe("33102001");
  });

  it("§7.5 bước 5: BANK_PAYMENT_% và BANK_INTERNAL_TRANSFER_TO lấy Amount đã trừ phí", () => {
    expect(pipoAmountExcludesFee("BANK_PAYMENT_SELLER")).toBe(true);
    expect(pipoAmountExcludesFee("BANK_INTERNAL_TRANSFER_TO")).toBe(true);
    expect(pipoAmountExcludesFee("BANK_INTERNAL_TRANSFER_FROM")).toBe(false);

    // Dòng thật: Amount -101.01 đã gồm phí 1.01 → gốc 100.00 + phí 1.01 = 101.01 rút khỏi tài khoản
    const row = { Amount: -101.01, Fee: 1.01, Net: 100 } as never;
    const withFee = pipoSpec.amounts(row, "BANK_INTERNAL_TRANSFER_TO");
    expect(withFee.AMOUNT?.toNumber()).toBeCloseTo(-100, 10);
    expect(withFee.FEE?.toNumber()).toBe(1.01);

    // Nghiệp vụ không thuộc danh sách → giữ nguyên Amount
    const asIs = pipoSpec.amounts(row, "BANK_INTERNAL_TRANSFER_FROM");
    expect(asIs.AMOUNT?.toNumber()).toBe(-101.01);
  });

  it("post ra chứng từ cân", async () => {
    const { built, totalDr, totalCr, failed, noClassify } = buildAndPost(await loadSamplePipo(), pipoSpec);
    expect(built.stats.events).toBe(48);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);
  });
});

describe("Build AccountingSource", () => {
  it("Master Card: 39 dòng → Nợ 11202091 (thẻ) / Có 11202061 (PingPong), tổng 1.076,87 USD", async () => {
    const rows = await loadSampleAccountingSource("master-card-sample.csv", "Master Card");
    const { built, glLines, totalDr, totalCr, failed } = buildAndPost(rows, accountingSourceSpec);

    expect(built.stats.sourceRows).toBe(39);
    expect(built.stats.errorRows).toBe(0);
    expect(built.stats.events).toBe(39);
    expect(failed).toEqual([]);
    expect(totalDr).toBe(1076.87);
    expect(totalCr).toBe(1076.87);

    // BankGLAccount đến từ MappingBankAccount theo số thẻ, Contra là mặc định của sheet Master Card
    const e = built.events[0];
    expect(e.BankGLAccount).toBe("11202091");
    expect(e.ContraAccount).toBe("11202061");
    expect(e.Amount).toBeGreaterThan(0); // Credit = tiền vào thẻ
    expect(glLines.filter((l) => l.AccountCode === "11202091" && (l.AccountedDr ?? 0) > 0).length).toBe(39);
  });

  it("Bank_Royal: tài khoản ghi trên dòng thắng mặc định JournalType, BalanceImpact quyết định chiều", async () => {
    const rows = await loadSampleAccountingSource("bank-royal-sample.csv", "Bank_Royal");
    const r = buildBankEvents(rows, accountingSourceSpec, index);

    expect(r.stats.sourceRows).toBe(31);
    expect(r.stats.errorRows).toBe(0);

    // BANK_PAYMENT_SUPPLIER dùng 2 cặp Contra/Trans khác nhau, đều khác mặc định 33111002 của master
    const supplier = r.events.filter((e) => e.JournalTypeCode === "BANK_PAYMENT_SUPPLIER");
    expect([...new Set(supplier.map((e) => `${e.ContraAccount}/${e.TransAccount}`))].sort()).toEqual([
      "33102002/64202002",
      "33402001/64202001",
    ]);
    // Debit = tiền ra khỏi ngân hàng → Amount âm → rule REVERSE sẽ đảo Nợ/Có khi post
    expect(supplier.every((e) => e.Amount < 0)).toBe(true);

    const transferIn = r.events.filter((e) => e.JournalTypeCode === "BANK_INTERNAL_TRANSFER_FROM");
    expect(transferIn.every((e) => e.Amount > 0)).toBe(true);
    expect([...new Set(transferIn.map((e) => e.ContraAccount))].sort()).toEqual(["11202053", "11202061"]);
  });

  it("Bank_Royal là nguồn CAD → post quy đổi sang USD theo tỷ giá của kỳ", async () => {
    const rows = await loadSampleAccountingSource("bank-royal-sample.csv", "Bank_Royal");
    const { built, glLines, totalDr, totalCr, failed } = buildAndPost(rows, accountingSourceSpec);

    expect(built.events.every((e) => e.InputCurr === "CAD" && e.FncCurr === "USD")).toBe(true);
    expect(failed).toEqual([]);
    expect(totalDr).toBe(totalCr);

    // Exrate 202508 CAD→USD là DIV 1.3802 → AccountedDr nhỏ hơn InputDr
    const fee = glLines.find((l) => l.Period === "202508" && (l.InputDr ?? 0) > 0)!;
    expect(fee.RateType).toBe("DIV");
    expect(fee.XRate).toBeCloseTo(1.3802, 4);
    expect(fee.AccountedDr).toBeCloseTo((fee.InputDr ?? 0) / 1.3802, 2);
  });

  it("SourceKey của Bank_Royal ổn định và tách được 2 dòng trùng y hệt", async () => {
    const rows = await loadSampleAccountingSource("bank-royal-sample.csv", "Bank_Royal");
    const keys = rows.map((r) => r.SourceKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Bank_Royal không có RefNum nào → khóa là hash nội dung + số thứ tự lần xuất hiện
    expect(keys.every((k) => k.startsWith("RB|"))).toBe(true);
    expect(keys.some((k) => k.endsWith("#2"))).toBe(true);
  });
});
