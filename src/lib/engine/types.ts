import type { AccountingEventInsert, GLTransInsert } from "@/lib/db/schema";

export type Severity = "INFO" | "WARNING" | "ERROR";

export type ExceptionType =
  | "NOT_FULFILLED"
  | "INVALID_FULFILLED_DATE"
  | "MISSING_COMCODE"
  | "MISSING_COMPANY"
  /** Dòng nguồn ngân hàng/PSP bị loại theo điều kiện của nguồn (non-USD, PIPO Status ≠ Success…) */
  | "SOURCE_ROW_SKIPPED"
  /** Dòng nguồn thiếu dữ liệu bắt buộc để ghi sổ (ngày, số tiền, JournalType…) */
  | "INVALID_SOURCE_ROW"
  | "MISSING_JOURNAL_TYPE"
  | "MISSING_RULE"
  | "UNKNOWN_AMOUNT_SOURCE"
  | "MISSING_PARTNER"
  | "MISSING_ACCOUNT"
  | "ACCOUNT_NOT_IN_COA"
  | "AMOUNT_ZERO"
  | "NEGATIVE_AMOUNT"
  | "MISSING_FX"
  | "POSTED_SOURCE_CHANGED"
  | "POSTED_KEY_CHANGED"
  | "DUPLICATE_ITEM";

export interface ExceptionDraft {
  DataSource: string;
  ComCode: string | null;
  Period: string | null;
  Severity: Severity;
  ExceptionType: ExceptionType;
  SourceKey: string | null;
  Message: string;
}

/** Event chưa có ID (engine Build sinh ra) */
export type EventDraft = Omit<
  AccountingEventInsert,
  "AccountingEventID" | "BuildBatchID" | "AddDate" | "ModifiedDate" | "PostBatchID" | "PostedAt" | "PostedDocNum" | "PostingGroupKey"
> & {
  /** Khóa chính của các dòng raw tạo nên event (RawOrderID / RawPaypalID / …) — để truy vết */
  rawRowIds: number[];
};

/** Dòng GL chưa có ID / PostBatchID / AddDate (engine Post sinh ra) */
export type GlLineDraft = Omit<GLTransInsert, "ID" | "PostBatchID" | "AddDate" | "ModifiedDate">;
