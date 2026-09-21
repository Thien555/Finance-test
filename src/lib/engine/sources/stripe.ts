/**
 * Spec nguồn Stripe (tài liệu §7.6). Sheet `Bank_Stripe` của Data-khac-order.xlsx.
 *
 *  - Chỉ build Currency = USD. File ghi `usd` **chữ thường** nên phải uppercase trước khi so.
 *  - Cột `JournalType` điền tay thắng; trống thì suy từ `Type` (raw TransType: charge/refund/payout/
 *    stripe_fee/adjustment/reserved_funds) qua `JournalType.JournalType` — đúng PA1 của §7.6.
 *  - `Fee` trong file mang dấu **dương** (ngược PayPal) và rule Stripe dùng `AmountFactor = 1`.
 *  - Cột `BankAccoutNumber` trong file luôn trống → mặc định `Stripe1` (MappingBankAccount → 11202081).
 */
import Decimal from "decimal.js";
import type { RawStripeRow } from "@/lib/db/schema";
import type { BankSourceSpec } from "../build-bank";

export const STRIPE_DATA_SOURCE = "STRIPE";
export const STRIPE_DEFAULT_BANK_ACCOUNT = "Stripe1";

const dec = (v: number | null) => (v === null || v === undefined ? new Decimal(0) : new Decimal(v));

export const stripeSpec: BankSourceSpec<RawStripeRow> = {
  dataSource: STRIPE_DATA_SOURCE,
  label: "Stripe",
  rowId: (r) => r.RawStripeID,
  sourceKey: (r) => r.SourceKey,
  transactionId: (r) => r.Id,
  accept: (r) =>
    (r.Currency ?? "").trim().toUpperCase() === "USD"
      ? { ok: true }
      : { ok: false, severity: "INFO", type: "SOURCE_ROW_SKIPPED", reason: `Stripe chỉ ghi sổ giao dịch USD (dòng này ${r.Currency ?? "trống"})` },
  comCode: (r) => r.ComCode,
  journalTypeCode: (r) => r.JournalType,
  nativeType: (r) => r.Type,
  postingDate: (r) => r.PostingDate,
  inputCurr: (r) => r.Currency,
  amounts: (r) => ({ AMOUNT: dec(r.Amount), FEE: dec(r.Fee), NET: dec(r.Net) }),
  bankAccountNumber: (r) => r.BankAccoutNumber?.trim() || STRIPE_DEFAULT_BANK_ACCOUNT,
  accountOverrides: () => ({}),
  partnerCode: (r) => r.PartnerCode,
  storeName: (r) => r.StoreName ?? r.MetaStoreName,
  orderId: (r) => r.MetaInvoiceId,
  refNum: (r) => r.Source ?? r.MetaInvoiceId,
  description: (r) => r.Type,
};
