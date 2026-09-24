import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { amountFromSource, type BankSourceSpec, buildBankEvents } from "@/lib/engine/build-bank";
import { classifyOf, postEvents } from "@/lib/engine/post";
import { paypalSpec, PAYPAL_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/paypal";
import { pipoAmountExcludesFee, pipoSpec, PIPO_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/pipo";
import { stripeSpec, STRIPE_DEFAULT_BANK_ACCOUNT } from "@/lib/engine/sources/stripe";
import {
  loadIndex,
  loadSamplePaypal,
  loadSamplePipo,
  loadSampleStripe,
  toEventRows,
} from "../helpers/fixtures";

const index = loadIndex();

/** Mọi chứng từ phải cân Nợ = Có, không chỉ tổng toàn bộ */
function expectBalancedByDocument(lines: { DocNum: string; AccountedDr?: number | null; AccountedCr?: number | null }[]) {
  const byDoc = new Map<string, Decimal>();
  for (const l of lines) {
    const delta = new Decimal(l.AccountedDr ?? 0).minus(l.AccountedCr ?? 0);
    byDoc.set(l.DocNum, (byDoc.get(l.DocNum) ?? new Decimal(0)).plus(delta));
  }
  expect([...byDoc].filter(([, v]) => !v.toDecimalPlaces(2).isZero())).toEqual([]);
}

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

describe("Build PayPal", () => {
  it("sinh event theo rule, bỏ rule thiếu TransAccount / fee = 0", async () => {
    const rows = await loadSamplePaypal();
    const r = buildBankEvents(rows, paypalSpec, index);

    expect(r.stats.sourceRows).toBe(142_659);
    expect(r.stats.skippedRows).toBe(0);
    // 1 dòng "General Currency Conversion": master chỉ có PP_USER_INITIATED_CURRENCY_CONVERSION
    expect(r.stats.errorRows).toBe(1);
    expect(r.exceptions.filter((e) => e.ExceptionType === "MISSING_JOURNAL_TYPE").map((e) => e.SourceKey)).toEqual([
      "PP_GENERAL_CURRENCY_CONVERSION",
    ]);

    // Hold/Release: Contra = 11202052, TransAccount NULL → chỉ còn rule 10
    const hold = r.events.filter((e) => e.JournalTypeCode === "PP_RESERVE_HOLD");
    expect(hold).toHaveLength(53_854);
    expect(hold.every((e) => e.EventSeq === 10)).toBe(true);
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

    expect(built.stats.events).toBe(198_243);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);
    expect(totalDr).toBe(6_986_394.87);
    expect(glLines).toHaveLength(10_260);
    expect(new Set(glLines.map((l) => l.DocNum)).size).toBe(4_778);
    expectBalancedByDocument(glLines);

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
    const { built, glLines, totalDr, totalCr, failed, noClassify } = buildAndPost(await loadSampleStripe(), stripeSpec);
    expect(built.stats.events).toBe(2_712);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);
    expect(totalDr).toBe(123_799.26);
    expect(glLines).toHaveLength(928);
    expect(new Set(glLines.map((l) => l.DocNum)).size).toBe(287);
    expectBalancedByDocument(glLines);
  });
});

describe("Build PIPO", () => {
  it("bỏ dòng Status ≠ Success", async () => {
    const rows = await loadSamplePipo();
    const r = buildBankEvents(rows, pipoSpec, index);
    // 2 dòng "Retrieved" + 1 dòng Status trống; exception gom nhóm nên chỉ 2 dòng log
    expect(r.stats.skippedRows).toBe(3);
    const skips = r.exceptions.filter((e) => e.ExceptionType === "SOURCE_ROW_SKIPPED");
    expect(skips).toHaveLength(2);
    expect(skips.every((e) => e.Severity === "INFO")).toBe(true);
    expect(skips.some((e) => e.Message?.includes("Retrieved"))).toBe(true);
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
    const { built, glLines, totalDr, totalCr, failed, noClassify } = buildAndPost(await loadSamplePipo(), pipoSpec);
    expect(built.stats.events).toBe(968);
    expect(failed).toEqual([]);
    expect(noClassify).toEqual([]);
    expect(totalDr).toBe(totalCr);
    expect(totalDr).toBe(3_223_254.07);
    expect(glLines).toHaveLength(1_936);
    expect(new Set(glLines.map((l) => l.DocNum)).size).toBe(968);
    expectBalancedByDocument(glLines);
  });
});
