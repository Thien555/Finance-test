/**
 * Quy tắc sinh khóa/mã chứng từ — lấy theo format trong sheet mẫu AccountingEvent & GlTrans.
 */
import { createHash } from "node:crypto";

/** "2025-11-20" → "20251120" */
export const ymd = (date: string) => date.slice(0, 10).replaceAll("-", "");

/** "2025-11-20" → "202511" */
export const periodOf = (date: string) => date.slice(0, 4) + date.slice(5, 7);

/** AccountingEvent.TransactionID của Orders: ORD-{OrderId}-{yyyyMMdd} */
export const orderTransactionId = (orderId: string, postingDate: string) => `ORD-${orderId}-${ymd(postingDate)}`;

/** AccountingEvent.SourceID của Orders: {OrderId}|{yyyyMMdd} */
export const orderSourceId = (orderId: string, postingDate: string) => `${orderId}|${ymd(postingDate)}`;

/**
 * AccountingEvent.TransactionID của nguồn ngân hàng/PSP = mã giao dịch gốc trên file.
 * Khóa event đã gồm JournalTypeCode nên mã trùng ở 2 loại nghiệp vụ khác nhau vẫn hợp lệ
 * (PayPal có 37 mã trùng kiểu Hold → Cancel Hold).
 */
export const bankTransactionId = (nativeId: string) => nativeId.trim();

/** AccountingEvent.SourceID của nguồn ngân hàng/PSP: {DataSource}|{SourceKey của dòng raw} */
export const bankSourceId = (dataSource: string, sourceKey: string) => `${dataSource}|${sourceKey}`;

/** DocNum Post Single: ASI-{yyyyMMdd}-{AccountingEventID} */
export const singleDocNum = (postingDate: string, eventId: number) => `ASI-${ymd(postingDate)}-${eventId}`;

/** DocNum Post Bulk: ASB-{yyyyMMdd}-{AccountingEventID nhỏ nhất trong group} */
export const bulkDocNum = (postingDate: string, minEventId: number) => `ASB-${ymd(postingDate)}-${minEventId}`;

/**
 * PostingGroupKey (Bulk):
 * ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber
 * VD sample: ONTARIO|ORD_SELLER_PROFIT_FULFILLED|20250526|USD|USD|CANHLX29@GMAIL.COM|5FT4UUUKURUCNOSGME|
 */
export function postingGroupKey(e: {
  ComCode: string;
  JournalTypeCode: string;
  PostingDate: string;
  InputCurr: string;
  FncCurr: string;
  PartnerCode: string | null;
  PartnerTaxID: string | null;
  BankAccountNumber: string | null;
}): string {
  return [
    e.ComCode,
    e.JournalTypeCode,
    ymd(e.PostingDate),
    e.InputCurr,
    e.FncCurr,
    (e.PartnerCode ?? "").toUpperCase(),
    e.PartnerTaxID ?? "",
    e.BankAccountNumber ?? "",
  ].join("|");
}

/** Khóa duy nhất của AccountingEvent */
export function eventKey(e: {
  ComCode: string;
  DataSource: string;
  JournalTypeCode: string;
  TransactionID: string;
  EventSeq: number;
}): string {
  return [e.ComCode, e.DataSource, e.JournalTypeCode, e.TransactionID, e.EventSeq].join("|");
}

export function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").toUpperCase();
}
