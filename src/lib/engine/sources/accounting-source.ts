/**
 * Spec nguồn AccountingSource (tài liệu §7.2). Gộp 2 sheet nhập tay `Master Card` và `Bank_Royal`.
 *
 *  - Hai sheet này không nằm trong §5.1 nhưng cả hai đều điền JournalType của `DataSource = AccountingSource`
 *    (`BANK_BANK_FEE`, `BANK_PAYMENT_SUPPLIER`, `BANK_INTERNAL_TRANSFER_FROM`, `BANK_RECEIPT_OTHER`).
 *  - `Bank_Royal` mang sẵn `BankAccount / ContraAccount / TransAccount` **riêng từng dòng** và khác mặc định
 *    của JournalType (VD `BANK_PAYMENT_SUPPLIER` dùng `33402001/64202001` cho lương, `33102002/64202002`
 *    cho phí kế toán, trong khi master mặc định `33111002`) → đúng tầng "account nhập trên source" của §7.2 bước 3.
 *  - `Amount` trên cả 2 sheet luôn **dương**; chiều tiền nằm ở `BalanceImpact` và đã được đổi thành dấu
 *    ngay ở bước Import (xem src/lib/accounting-source/normalize.ts) để engine chỉ làm việc với số có dấu.
 *  - `Bank_Royal` là nguồn duy nhất dùng CAD → đây là nơi tỷ giá thực sự được dùng.
 */
import Decimal from "decimal.js";
import type { RawAccountingSourceRow } from "@/lib/db/schema";
import type { BankAccounts, BankSourceSpec } from "../build-bank";

/** Viết HOA để khớp `norm("AccountingSource")` khi tra JournalType và `scopeWhere` (uppercase dataSource) */
export const ACCOUNTING_SOURCE_DATA_SOURCE = "ACCOUNTINGSOURCE";

export const ACCOUNTING_SOURCE_SHEETS = ["Master Card", "Bank_Royal"] as const;
export type AccountingSourceSheet = (typeof ACCOUNTING_SOURCE_SHEETS)[number];

const dec = (v: number | null) => (v === null || v === undefined ? new Decimal(0) : new Decimal(v));
/** Chỉ đưa vào override khi dòng nguồn thực sự có giá trị — `undefined` mới rơi xuống MappingBankAccount/JournalType */
const override = (v: string | null) => (v?.trim() ? v.trim() : undefined);

export const accountingSourceSpec: BankSourceSpec<RawAccountingSourceRow> = {
  dataSource: ACCOUNTING_SOURCE_DATA_SOURCE,
  label: "AccountingSource",
  rowId: (r) => r.RawAccountingSourceID,
  sourceKey: (r) => r.SourceKey,
  transactionId: (r) => r.IDTransaction ?? r.RefNum,
  accept: () => ({ ok: true }),
  comCode: (r) => r.ComCode,
  journalTypeCode: (r) => r.JournalType,
  // Hai sheet nhập tay không có "loại giao dịch gốc" để suy ra → bắt buộc điền cột JournalType
  nativeType: () => null,
  postingDate: (r) => r.PostingDate,
  inputCurr: (r) => r.InputCurr ?? r.Currency,
  // Rule BANK_* có pair FEE_BANK; 2 sheet này không có cột phí → FEE = 0 để rule tự bị bỏ (SkipIfAmountZero)
  amounts: (r) => ({ AMOUNT: dec(r.Amount), FEE: new Decimal(0) }),
  bankAccountNumber: (r) => r.BankAccountNumber,
  accountOverrides: (r): Partial<BankAccounts> => ({
    BankGLAccount: override(r.BankAccount),
    ContraAccount: override(r.ContraAccount),
    TransAccount: override(r.TransAccount),
  }),
  partnerCode: (r) => r.PartnerCode,
  storeName: () => null,
  orderId: () => null,
  refNum: (r) => r.RefNum,
  description: (r) => r.Description?.trim() || `${r.SheetName} | ${r.JournalType ?? ""}`.trim(),
};
