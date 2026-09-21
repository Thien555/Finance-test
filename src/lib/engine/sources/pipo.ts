/**
 * Spec nguồn PIPO / PingPong (tài liệu §7.5). Sheet `Bank_Pipo` của Data-khac-order.xlsx.
 *
 *  - Chỉ xử lý `Status = Success` (§7.5 bước 2). File còn trạng thái `Retrieved` → bỏ qua + exception INFO.
 *  - File điền sẵn các mã `BANK_*` vốn thuộc `DataSource = AccountingSource`. Master đã được bổ sung
 *    10 dòng `DataSource = PIPO` dùng lại đúng các mã đó nhưng `BankAccount = 11202061` (PingPong)
 *    thay vì `11202001` (Bank CA). JournalLineRule khóa theo JournalTypeCode nên dùng chung rule sẵn có.
 *  - Cột `Amount`, `Fee`, `Net` là **text có đuôi tiền tệ** (`"1.01USD"`, `"100.00USD"`) → `parseNumber` bóc phần số.
 *  - §7.5 bước 5: với `BANK_PAYMENT_%` và `BANK_INTERNAL_TRANSFER_TO` thì **Amount chính = Amount loại trừ fee**,
 *    Fee vẫn đi riêng qua rule FEE_BANK. Dữ liệu thật khớp đúng quy ước này: một dòng Send ghi
 *    `Amount -101.01 / Fee 1.01USD / Net 100.00USD` — tức `Amount` đã **gồm cả phí**, người nhận thực nhận 100.00.
 *    Nhờ vậy 2 bút toán (gốc 100.00 + phí 1.01) cộng lại đúng 101.01 rút khỏi tài khoản.
 *  - `Amount` đã mang dấu sẵn (Send/Withdraw âm, Receive dương) → dùng nguyên, rule `NegativeMode = REVERSE`
 *    tự đảo Nợ/Có.
 *  - Cột `BankAccoutNumber` trống → mặc định `PINGPONG1` (MappingBankAccount → 11202061).
 *    Không dùng `CardNo`: đó là số thẻ/ví, không phải tài khoản có trong MappingBankAccount.
 */
import Decimal from "decimal.js";
import type { RawPipoRow } from "@/lib/db/schema";
import type { BankSourceSpec } from "../build-bank";

export const PIPO_DATA_SOURCE = "PIPO";
export const PIPO_DEFAULT_BANK_ACCOUNT = "PINGPONG1";

const dec = (v: number | null) => (v === null || v === undefined ? new Decimal(0) : new Decimal(v));

/** §7.5 bước 5 — nghiệp vụ mà số tiền chính phải trừ phí ra */
export function pipoAmountExcludesFee(journalTypeCode: string): boolean {
  const jtc = journalTypeCode.trim().toUpperCase();
  return jtc.startsWith("BANK_PAYMENT_") || jtc === "BANK_INTERNAL_TRANSFER_TO";
}

export const pipoSpec: BankSourceSpec<RawPipoRow> = {
  dataSource: PIPO_DATA_SOURCE,
  label: "PIPO",
  rowId: (r) => r.RawPipoID,
  sourceKey: (r) => r.SourceKey,
  transactionId: (r) => r.TransactionId,
  accept: (r) =>
    (r.Status ?? "").trim().toUpperCase() === "SUCCESS"
      ? { ok: true }
      : { ok: false, severity: "INFO", type: "SOURCE_ROW_SKIPPED", reason: `PIPO chỉ ghi sổ giao dịch Status = Success (dòng này ${r.Status ?? "trống"})` },
  comCode: (r) => r.ComCode,
  journalTypeCode: (r) => r.JournalType,
  nativeType: (r) => r.Type,
  postingDate: (r) => r.PostingDate,
  inputCurr: (r) => r.Currency,
  amounts: (r, journalTypeCode) => {
    const amount = dec(r.Amount);
    const fee = dec(r.Fee).abs();
    if (!pipoAmountExcludesFee(journalTypeCode) || fee.isZero()) {
      return { AMOUNT: amount, FEE: fee, NET: dec(r.Net) };
    }
    // Giữ dấu của Amount, bỏ phần phí ra khỏi số tiền chính
    const sign = amount.isNegative() ? -1 : 1;
    return { AMOUNT: amount.abs().minus(fee).times(sign), FEE: fee, NET: dec(r.Net) };
  },
  bankAccountNumber: (r) => r.BankAccoutNumber?.trim() || PIPO_DEFAULT_BANK_ACCOUNT,
  accountOverrides: () => ({}),
  partnerCode: (r) => r.PartnerCode,
  storeName: (r) => r.StoreName,
  orderId: () => null,
  refNum: (r) => r.TransactionId,
  description: (r) => r.Note?.trim() || r.Type,
};
