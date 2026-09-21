/**
 * Chuẩn hóa 1 dòng sheet nguồn (ngoài Orders) → dòng bảng raw tương ứng.
 *
 * `SourceKey` là khóa định danh dòng và **không được phụ thuộc các cột người dùng điền tay**
 * (`JournalType`, `PartnerCode`, `StoreName`, các cột tài khoản). Nhờ vậy sửa tay rồi import lại
 * sẽ đổi `RowHash` nhưng giữ nguyên `SourceKey` → tầng Import chặn được đúng dòng đã build/post.
 */
import type {
  RawAccountingSourceInsert,
  RawPaypalInsert,
  RawPipoInsert,
  RawStripeInsert,
} from "@/lib/db/schema";
import { sha256 } from "@/lib/engine/keys";
import { parseDate, parseDateTime, parseNumber, parseTimeOfDay, toText } from "@/lib/engine/parse";
import { canonicalHeaderMap, type SourceColumn } from "./columns";

export { canonicalHeaderMap };

export type NormalizeResult<T> = { ok: true; row: T } | { ok: false; key: string | null; error: string };

/** Giá trị đã chuẩn hóa của 1 dòng, khóa theo **tên header của sheet** */
export type SourceValues = Record<string, string | number | null>;

export function projectRow(
  record: Record<string, unknown>,
  headerMap: Map<string, string>,
  columns: SourceColumn[],
): SourceValues {
  const source: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(record)) {
    const canonical = headerMap.get(header);
    if (canonical) source[canonical] = value;
  }
  const out: SourceValues = {};
  for (const [name, kind] of columns) {
    const v = source[name];
    switch (kind) {
      case "number":
        out[name] = parseNumber(v);
        break;
      case "date":
        out[name] = parseDate(v) ?? toText(v);
        break;
      case "datetime":
        out[name] = parseDateTime(v) ?? toText(v);
        break;
      case "time":
        out[name] = parseTimeOfDay(v);
        break;
      default:
        out[name] = toText(v);
    }
  }
  return out;
}

const str = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);
const num = (v: string | number | null | undefined): number | null => (typeof v === "number" ? v : parseNumber(v));
/** "2026-04-27 08:30:00" / "2026-04-27" → "2026-04-27" */
const dayOf = (v: string | number | null | undefined): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

// ───────────────────────────── PayPal ─────────────────────────────

export function normalizePaypalRow(
  record: Record<string, unknown>,
  headerMap: Map<string, string>,
  columns: SourceColumn[],
): NormalizeResult<Omit<RawPaypalInsert, "RawPaypalID" | "ImportBatchID">> {
  const v = projectRow(record, headerMap, columns);
  const txnId = str(v["Transaction ID"]);
  const date = dayOf(v.Date);
  const key = txnId;
  if (!txnId) return { ok: false, key, error: "Thiếu Transaction ID" };
  if (!date) return { ok: false, key, error: `Cột Date không đọc được ngày: "${str(v.Date) ?? ""}"` };

  // TxnID|Date|Time là duy nhất trên toàn bộ 142.659 dòng (TxnID đơn lẻ có 37 mã trùng)
  const time = str(v.Time) ?? "";
  return {
    ok: true,
    row: {
      SourceKey: `${txnId}|${date}|${time}`,
      ComCode: str(v.ComCode)?.toUpperCase() ?? null,
      PostingDate: date,
      BuildStatus: "NOT_BUILT",
      BuildMessage: null,
      RowHash: sha256(v),
      Date: date,
      Time: time || null,
      TimeZone: str(v["Time Zone"]),
      Description: str(v.Description),
      Currency: str(v.Currency)?.toUpperCase() ?? null,
      Gross: num(v.Gross),
      Fee: num(v.Fee),
      Net: num(v.Net),
      Balance: num(v.Balance),
      TransactionID: txnId,
      FromEmailAddress: str(v["From Email Address"]),
      Name: str(v.Name),
      BankName: str(v["Bank Name"]),
      BankAccount: str(v["Bank account"]),
      PostageAndPackagingAmount: num(v["Postage and Packaging Amount"]),
      VAT: num(v.VAT),
      InvoiceID: str(v["Invoice ID"]),
      ReferenceTxnID: str(v["Reference Txn ID"]),
      JournalType: str(v.JournalType),
      StoreName: str(v.StoreName),
      PartnerCode: str(v.PartnerCode),
      BankAccoutNumber: str(v.BankAccoutNumber),
    },
  };
}

// ───────────────────────────── Stripe ─────────────────────────────

export function normalizeStripeRow(
  record: Record<string, unknown>,
  headerMap: Map<string, string>,
  columns: SourceColumn[],
): NormalizeResult<Omit<RawStripeInsert, "RawStripeID" | "ImportBatchID">> {
  const v = projectRow(record, headerMap, columns);
  const id = str(v.id);
  const date = dayOf(v.Date) ?? dayOf(v["Created (UTC)"]);
  if (!id) return { ok: false, key: null, error: "Thiếu cột id" };
  if (!date) return { ok: false, key: id, error: `Cột Date không đọc được ngày: "${str(v.Date) ?? ""}"` };

  return {
    ok: true,
    row: {
      SourceKey: id,
      ComCode: str(v.ComCode)?.toUpperCase() ?? null,
      PostingDate: date,
      BuildStatus: "NOT_BUILT",
      BuildMessage: null,
      RowHash: sha256(v),
      Date: date,
      Id: id,
      Type: str(v.Type),
      Source: str(v.Source),
      Amount: num(v.Amount),
      Fee: num(v.Fee),
      Net: num(v.Net),
      // File ghi "usd" chữ thường; uppercase để bộ lọc USD và tra tỷ giá hoạt động
      Currency: str(v.Currency)?.toUpperCase() ?? null,
      CreatedUtc: str(v["Created (UTC)"]),
      AvailableOnUtc: str(v["Available On (UTC)"]),
      MetaReason: str(v["reason (metadata)"]),
      MetaAmount: num(v["amount (metadata)"]),
      MetaFromOurPlatform: str(v["fromOurPlatform (metadata)"]),
      MetaNote: str(v["note (metadata)"]),
      MetaInvoiceId: str(v["invoiceId (metadata)"]),
      MetaStoreId: str(v["storeId (metadata)"]),
      MetaDomain: str(v["domain (metadata)"]),
      MetaDiscount: num(v["discount (metadata)"]),
      MetaFreeShip: str(v["freeShip (metadata)"]),
      MetaLink: str(v["link (metadata)"]),
      MetaItem: str(v["item (metadata)"]),
      MetaShippingFee: num(v["shippingFee (metadata)"]),
      MetaSubTotal: num(v["subTotal (metadata)"]),
      MetaTax: num(v["tax (metadata)"]),
      MetaStoreName: str(v["storeName (metadata)"]),
      JournalType: str(v.JournalType),
      StoreName: str(v.StoreName),
      PartnerCode: str(v.PartnerCode),
      BankAccoutNumber: str(v.BankAccoutNumber),
    },
  };
}

// ───────────────────────────── PIPO ─────────────────────────────

export function normalizePipoRow(
  record: Record<string, unknown>,
  headerMap: Map<string, string>,
  columns: SourceColumn[],
): NormalizeResult<Omit<RawPipoInsert, "RawPipoID" | "ImportBatchID">> {
  const v = projectRow(record, headerMap, columns);
  const id = str(v.TransactionId);
  const date = dayOf(v.Time);
  if (!id) return { ok: false, key: null, error: "Thiếu TransactionId" };
  if (!date) return { ok: false, key: id, error: `Cột Time không đọc được ngày: "${str(v.Time) ?? ""}"` };

  return {
    ok: true,
    row: {
      SourceKey: id,
      ComCode: str(v.ComCode)?.toUpperCase() ?? null,
      PostingDate: date,
      BuildStatus: "NOT_BUILT",
      BuildMessage: null,
      RowHash: sha256(v),
      Time: str(v.Time),
      Currency: str(v.Currency)?.toUpperCase() ?? null,
      Amount: num(v.Amount),
      TransactionId: id,
      CardNo: str(v.CardNo),
      Fee: num(v.Fee),
      Rate: num(v.Rate),
      // Cột Net là text kiểu "0.17USD" → parseNumber bóc phần số
      Net: num(v.Net),
      Type: str(v.Type),
      // Ô "From/To" có xuống dòng bên trong → gộp thành 1 dòng cho dễ đọc
      FromTo: str(v["From/To"])?.replace(/\s*\n\s*/g, " ") ?? null,
      Status: str(v.Status),
      Note: str(v.Note),
      JournalType: str(v.JournalType),
      StoreName: str(v.StoreName),
      PartnerCode: str(v.PartnerCode),
      BankAccoutNumber: str(v.BankAccoutNumber),
    },
  };
}

// ──────────────────────── AccountingSource ────────────────────────

/** Sheet "Master Card" không có cột ContraAccount; 39/39 dòng là nhận tiền từ PingPong */
export const MASTER_CARD_DEFAULT_CONTRA = "11202061";
/** Sheet "Master Card" không có cột BalanceImpact; mọi dòng là BANK_INTERNAL_TRANSFER_FROM (tiền vào) */
export const MASTER_CARD_DEFAULT_BALANCE_IMPACT = "Credit";

/**
 * `Amount` trên 2 sheet luôn dương; chiều tiền nằm ở `BalanceImpact` theo quy ước sao kê ngân hàng:
 * `Debit` = tiền **ra** khỏi tài khoản → số âm; `Credit` = tiền **vào** → số dương.
 * Rule `NegativeMode = REVERSE` sẽ tự đảo Nợ/Có khi số âm.
 */
export function signedAmount(amount: number | null, balanceImpact: string | null): number | null {
  if (amount === null) return null;
  const magnitude = Math.abs(amount);
  return (balanceImpact ?? "").trim().toUpperCase() === "DEBIT" ? -magnitude : magnitude;
}

export function normalizeAccountingSourceRow(
  record: Record<string, unknown>,
  headerMap: Map<string, string>,
  columns: SourceColumn[],
  sheetName: string,
  /** Đếm số lần xuất hiện của cùng một nội dung trong file — Bank_Royal có dòng trùng y hệt */
  seen: Map<string, number>,
): NormalizeResult<Omit<RawAccountingSourceInsert, "RawAccountingSourceID" | "ImportBatchID">> {
  const v = projectRow(record, headerMap, columns);
  const isMasterCard = sheetName === "Master Card";
  const comCode = str(v.Comcode);
  const date = dayOf(v.Date);
  const rawAmount = num(v.Amount);
  const idTransaction = str(v["ID Transaction"]);
  const key = idTransaction ?? str(v.RefNum);

  if (!comCode) return { ok: false, key, error: "Thiếu Comcode" };
  if (!date) return { ok: false, key, error: `Cột Date không đọc được ngày: "${str(v.Date) ?? ""}"` };
  if (rawAmount === null) return { ok: false, key, error: "Thiếu Amount" };

  const balanceImpact = str(v.BalanceImpact) ?? (isMasterCard ? MASTER_CARD_DEFAULT_BALANCE_IMPACT : null);

  // Khóa dòng: mã giao dịch nếu có; Bank_Royal không có RefNum nào nên hash phần nhận dạng của dòng
  // (cố ý KHÔNG gồm JournalType / các cột tài khoản / BalanceImpact — đó là phần người dùng điền tay).
  let sourceKey: string;
  if (idTransaction) {
    sourceKey = `MC|${idTransaction}`;
  } else {
    const identity = sha256([sheetName, comCode, str(v.BankAccountNumber), date, rawAmount, str(v.InputCurr), str(v.PartnerCode)]).slice(0, 32);
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    sourceKey = `RB|${identity}#${n}`;
  }

  return {
    ok: true,
    row: {
      SourceKey: sourceKey,
      ComCode: comCode.toUpperCase(),
      PostingDate: date,
      BuildStatus: "NOT_BUILT",
      BuildMessage: null,
      RowHash: sha256([sheetName, v]),
      SheetName: sheetName,
      BankAccountNumber: str(v.BankAccountNumber),
      JournalType: str(v.JournalType),
      PartnerCode: str(v.PartnerCode),
      Date: date,
      IDTransaction: idTransaction,
      Amount: signedAmount(rawAmount, balanceImpact),
      Currency: str(v.Currency)?.toUpperCase() ?? null,
      InputCurr: str(v.InputCurr)?.toUpperCase() ?? null,
      Description: str(v.Description),
      BalanceImpact: balanceImpact,
      RefNum: str(v.RefNum),
      Segment: str(v.Segment),
      IsPosted: str(v.IsPosted),
      BankAccount: str(v.BankAccount),
      ContraAccount: str(v.ContraAccount) ?? (isMasterCard ? MASTER_CARD_DEFAULT_CONTRA : null),
      TransAccount: str(v.TransAccount),
    },
  };
}
