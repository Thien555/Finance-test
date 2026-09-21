/**
 * Spec nguồn PayPal (tài liệu §7.4). Sheet `Bank_Paypal` của Data-khac-order.xlsx.
 *
 *  - Chỉ build Currency = USD (§7.4 bước 2)
 *  - Cột `JournalType` điền tay đã là JournalTypeCode; trống thì suy từ `Description`
 *    (Description ↔ JournalType trong file là 1:1 tuyệt đối — 22 loại)
 *  - `Fee` trong file mang dấu **âm**; rule pair 3 (FEE_BANK) dùng `AmountFactor = -1` nên đảo lại thành dương
 *  - Cột `BankAccoutNumber` trong file luôn trống → mặc định `PAYPAL1` (MappingBankAccount → 11202051)
 */
import Decimal from "decimal.js";
import type { RawPaypalRow } from "@/lib/db/schema";
import type { BankSourceSpec } from "../build-bank";

export const PAYPAL_DATA_SOURCE = "PAYPAL";
/** Số tài khoản nguồn mặc định khi file không ghi — phải có dòng MappingBankAccount tương ứng */
export const PAYPAL_DEFAULT_BANK_ACCOUNT = "PAYPAL1";

const dec = (v: number | null) => (v === null || v === undefined ? new Decimal(0) : new Decimal(v));

export const paypalSpec: BankSourceSpec<RawPaypalRow> = {
  dataSource: PAYPAL_DATA_SOURCE,
  label: "PayPal",
  rowId: (r) => r.RawPaypalID,
  sourceKey: (r) => r.SourceKey,
  transactionId: (r) => r.TransactionID,
  accept: (r) =>
    (r.Currency ?? "").trim().toUpperCase() === "USD"
      ? { ok: true }
      : { ok: false, severity: "INFO", type: "SOURCE_ROW_SKIPPED", reason: `PayPal chỉ ghi sổ giao dịch USD (dòng này ${r.Currency ?? "trống"})` },
  comCode: (r) => r.ComCode,
  journalTypeCode: (r) => r.JournalType,
  nativeType: (r) => r.Description,
  postingDate: (r) => r.PostingDate,
  inputCurr: (r) => r.Currency,
  amounts: (r) => ({ GROSS: dec(r.Gross), FEE: dec(r.Fee), NET: dec(r.Net) }),
  bankAccountNumber: (r) => r.BankAccoutNumber?.trim() || PAYPAL_DEFAULT_BANK_ACCOUNT,
  accountOverrides: () => ({}),
  partnerCode: (r) => r.PartnerCode,
  storeName: (r) => r.StoreName,
  orderId: (r) => r.InvoiceID,
  refNum: (r) => r.ReferenceTxnID ?? r.InvoiceID,
  description: (r) => r.Description,
};
