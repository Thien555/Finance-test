import type { AccountingEventInsert, GLTransInsert } from "@/lib/db/schema";

export type Severity = "INFO" | "WARNING" | "ERROR";

export type ExceptionType =
  | "NOT_FULFILLED"
  | "INVALID_FULFILLED_DATE"
  | "MISSING_COMCODE"
  | "MISSING_COMPANY"
  | "MISSING_JOURNAL_TYPE"
  | "MISSING_RULE"
  | "UNKNOWN_AMOUNT_SOURCE"
  | "MISSING_PARTNER"
  | "MISSING_ACCOUNT"
  | "ACCOUNT_NOT_IN_COA"
  | "AMOUNT_ZERO"
  | "NEGATIVE_AMOUNT"
  | "MISSING_FX"
  | "POSTED_SOURCE_CHANGED";

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
  /** RawOrderID của các dòng order tạo nên event (để truy vết) */
  rawOrderIds: number[];
};

/** Dòng GL chưa có ID / PostBatchID / AddDate (engine Post sinh ra) */
export type GlLineDraft = Omit<GLTransInsert, "ID" | "PostBatchID" | "AddDate" | "ModifiedDate">;
