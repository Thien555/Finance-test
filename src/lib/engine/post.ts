/**
 * POST: AccountingEvent (NEW) → GLTrans (tài liệu §9)
 *
 * Mỗi event:
 *  1. Join JournalLineRule theo JournalTypeCode + RuleSeq = EventSeq
 *  2. TK Nợ/Có = NormalDr/CrAccountSource → BankGLAccount / ContraAccount / TransAccount / FeeAccount của event
 *  3. Amount = Event.Amount × AmountFactor
 *  4. NegativeMode: SIGNED giữ dấu | REVERSE âm thì đảo Nợ/Có + trị tuyệt đối | ERROR âm thì báo lỗi
 *  5. Partner dòng: PartnerMode HEADER → partner của event, FIXED → FixedPartner; gắn theo ApplyPartnerToDr/CrLine
 *  6. FX resolve → AccountedDr/Cr
 *  7. Single: 1 event → 1 chứng từ 2 dòng (ASI-...)
 *     Bulk  : gom theo PostingGroupKey rồi SUM theo vế + TK + partner + tỷ giá (ASB-...)
 */
import Decimal from "decimal.js";
import type { AccountingEventRow } from "@/lib/db/schema";
import { bulkDocNum, postingGroupKey, singleDocNum } from "./keys";
import { accountFromSource, type MasterIndex } from "./masters";
import { applyFx, resolveFx } from "./resolve-fx";
import { type ResolvedPartner, resolveFixedPartner } from "./resolve-partner";
import type { ExceptionDraft, ExceptionType, GlLineDraft } from "./types";

export type Classify = "Single" | "Bulk";

export function classifyOf(index: MasterIndex, e: Pick<AccountingEventRow, "DataSource" | "JournalTypeCode">): Classify | null {
  const c = index.journalType(e.DataSource, e.JournalTypeCode)?.Classify?.trim().toUpperCase();
  if (c === "SINGLE") return "Single";
  if (c === "BULK") return "Bulk";
  return null;
}

interface ExpandedLine {
  side: "Debit" | "Credit";
  AccountCode: string;
  PartnerCode: string | null;
  PartnerTaxID: string | null;
  input: Decimal;
  accounted: Decimal;
  XRate: number;
  RateType: "MUL" | "DIV";
  memo: string;
  PairCode: string | null;
}

type ExpandResult =
  | { ok: true; lines: [ExpandedLine, ExpandedLine] }
  | { ok: false; skip: boolean; type: ExceptionType; message: string };

/** Bước 1-6: 1 event → 1 dòng Nợ + 1 dòng Có */
export function expandEvent(e: AccountingEventRow, index: MasterIndex): ExpandResult {
  const rule = index.rule(e.JournalTypeCode, e.EventSeq);
  if (!rule) {
    return { ok: false, skip: false, type: "MISSING_RULE", message: `Không có JournalLineRule active ${e.JournalTypeCode} RuleSeq=${e.EventSeq}` };
  }

  let drAccount = accountFromSource(rule.NormalDrAccountSource, e);
  let crAccount = accountFromSource(rule.NormalCrAccountSource, e);
  if (!drAccount || !crAccount) {
    const missing = !drAccount ? rule.NormalDrAccountSource : rule.NormalCrAccountSource;
    const skip = (!drAccount && !!rule.SkipIfDrAccountNull) || (!crAccount && !!rule.SkipIfCrAccountNull);
    return { ok: false, skip, type: "MISSING_ACCOUNT", message: `Event thiếu ${missing}` };
  }
  for (const acc of [drAccount, crAccount]) {
    if (!index.hasAccount(acc)) {
      return { ok: false, skip: false, type: "ACCOUNT_NOT_IN_COA", message: `TK ${acc} không có trong CoA` };
    }
  }

  let amount = new Decimal(e.Amount).times(rule.AmountFactor ?? 1).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (amount.isZero() && rule.SkipIfAmountZero) {
    return { ok: false, skip: true, type: "AMOUNT_ZERO", message: "Amount × AmountFactor = 0" };
  }

  const negativeMode = (rule.NegativeMode ?? (rule.ReverseIfNegative ? "REVERSE" : "SIGNED")).trim().toUpperCase();
  if (amount.isNegative()) {
    if (negativeMode === "ERROR") {
      return { ok: false, skip: false, type: "NEGATIVE_AMOUNT", message: `Amount âm (${amount.toFixed(2)}) với NegativeMode=ERROR` };
    }
    if (negativeMode === "REVERSE") {
      [drAccount, crAccount] = [crAccount, drAccount];
      amount = amount.abs();
    }
  }

  const headerPartner: ResolvedPartner = { PartnerCode: e.PartnerCode, PartnerTaxID: e.PartnerTaxID, PartnerName: e.PartnerName };
  const linePartner =
    (rule.PartnerMode ?? "").trim().toUpperCase() === "FIXED" && rule.FixedPartner
      ? resolveFixedPartner(index, rule.FixedPartner.trim().toUpperCase())
      : headerPartner;

  const fx = resolveFx(index.masters.exrates, { period: e.Period, fncCurr: e.FncCurr, inputCurr: e.InputCurr });
  if (!fx.ok) return { ok: false, skip: false, type: "MISSING_FX", message: fx.error };
  const accounted = applyFx(amount, fx);
  const memo = rule.MemoTemplate ?? e.Description ?? e.JournalTypeCode;

  const line = (side: "Debit" | "Credit", account: string, applyPartner: number): ExpandedLine => ({
    side,
    AccountCode: account,
    PartnerCode: applyPartner ? linePartner.PartnerCode : null,
    PartnerTaxID: applyPartner ? linePartner.PartnerTaxID : null,
    input: amount,
    accounted,
    XRate: fx.XRate,
    RateType: fx.RateType,
    memo,
    PairCode: rule.PairCode,
  });

  return {
    ok: true,
    lines: [line("Debit", drAccount, rule.ApplyPartnerToDrLine), line("Credit", crAccount, rule.ApplyPartnerToCrLine)],
  };
}

export interface PostEventsResult {
  glLines: GlLineDraft[];
  posted: { AccountingEventID: number; PostedDocNum: string; PostingGroupKey: string | null }[];
  failed: { AccountingEventID: number; ErrorMessage: string }[];
  skipped: { AccountingEventID: number; ErrorMessage: string }[];
  exceptions: ExceptionDraft[];
  docCount: number;
}

const round2 = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

function glAmounts(side: "Debit" | "Credit", input: Decimal, accounted: Decimal) {
  return side === "Debit"
    ? { InputDr: round2(input), InputCr: 0, AccountedDr: round2(accounted), AccountedCr: 0 }
    : { InputDr: 0, InputCr: round2(input), AccountedDr: 0, AccountedCr: round2(accounted) };
}

export function postEvents(events: AccountingEventRow[], classify: Classify, index: MasterIndex): PostEventsResult {
  const result: PostEventsResult = { glLines: [], posted: [], failed: [], skipped: [], exceptions: [], docCount: 0 };

  const expanded: { event: AccountingEventRow; lines: [ExpandedLine, ExpandedLine] }[] = [];
  for (const e of [...events].sort((a, b) => a.AccountingEventID - b.AccountingEventID)) {
    const r = expandEvent(e, index);
    if (r.ok) {
      expanded.push({ event: e, lines: r.lines });
      continue;
    }
    (r.skip ? result.skipped : result.failed).push({ AccountingEventID: e.AccountingEventID, ErrorMessage: r.message });
    result.exceptions.push({
      DataSource: e.DataSource,
      ComCode: e.ComCode,
      Period: e.Period,
      Severity: r.skip ? "INFO" : "ERROR",
      ExceptionType: r.type,
      SourceKey: `EventID ${e.AccountingEventID} | ${e.TransactionID}`,
      Message: r.message,
    });
  }

  if (classify === "Single") {
    for (const { event: e, lines } of expanded) {
      const docNum = singleDocNum(e.PostingDate, e.AccountingEventID);
      for (const l of lines) {
        result.glLines.push({
          ComCode: e.ComCode,
          DataSource: e.DataSource,
          JournalTypeCode: e.JournalTypeCode,
          DocNum: docNum,
          PostingGroupKey: null,
          ReferenceTxnID: e.TransactionID,
          OrderID: e.OrderID,
          RefNum: e.RefNum,
          TransDate: e.PostingDate,
          DocDate: e.PostingDate,
          Period: e.Period,
          AccountCode: l.AccountCode,
          BankAccountNumber: e.BankAccountNumber,
          PartnerCode: l.PartnerCode,
          PartnerTaxID: l.PartnerTaxID,
          InputCurr: e.InputCurr,
          FncCurr: e.FncCurr,
          ...glAmounts(l.side, l.input, l.accounted),
          XRate: l.XRate,
          RateType: l.RateType,
          Description: `${l.memo} | ${e.TransactionID}`,
          BalanceImpact: l.side,
        });
      }
      result.posted.push({ AccountingEventID: e.AccountingEventID, PostedDocNum: docNum, PostingGroupKey: null });
      result.docCount++;
    }
  } else {
    interface Agg {
      line: ExpandedLine;
      input: Decimal;
      accounted: Decimal;
    }
    interface Group {
      key: string;
      first: AccountingEventRow;
      events: AccountingEventRow[];
      lines: Map<string, Agg>;
    }
    const groups = new Map<string, Group>();

    for (const { event: e, lines } of expanded) {
      const key = postingGroupKey(e);
      let g = groups.get(key);
      if (!g) {
        g = { key, first: e, events: [], lines: new Map() };
        groups.set(key, g);
      }
      g.events.push(e);
      for (const l of lines) {
        const lineKey = [l.PairCode, l.side, l.AccountCode, l.PartnerCode, l.PartnerTaxID, l.XRate, l.RateType].join("|");
        const agg = g.lines.get(lineKey);
        if (agg) {
          agg.input = agg.input.plus(l.input);
          agg.accounted = agg.accounted.plus(l.accounted);
        } else {
          g.lines.set(lineKey, { line: l, input: l.input, accounted: l.accounted });
        }
      }
    }

    for (const g of groups.values()) {
      const e = g.first;
      const minId = Math.min(...g.events.map((x) => x.AccountingEventID));
      const docNum = bulkDocNum(e.PostingDate, minId);
      for (const { line: l, input, accounted } of g.lines.values()) {
        result.glLines.push({
          ComCode: e.ComCode,
          DataSource: e.DataSource,
          JournalTypeCode: e.JournalTypeCode,
          DocNum: docNum,
          PostingGroupKey: g.key,
          ReferenceTxnID: null,
          OrderID: null,
          RefNum: null,
          TransDate: e.PostingDate,
          DocDate: e.PostingDate,
          Period: e.Period,
          AccountCode: l.AccountCode,
          BankAccountNumber: e.BankAccountNumber,
          PartnerCode: l.PartnerCode,
          PartnerTaxID: l.PartnerTaxID,
          InputCurr: e.InputCurr,
          FncCurr: e.FncCurr,
          ...glAmounts(l.side, input, accounted),
          XRate: l.XRate,
          RateType: l.RateType,
          Description: `${l.memo} | ${g.events.length} events`,
          BalanceImpact: l.side,
        });
      }
      for (const x of g.events) {
        result.posted.push({ AccountingEventID: x.AccountingEventID, PostedDocNum: docNum, PostingGroupKey: g.key });
      }
      result.docCount++;
    }
  }

  assertBalanced(result.glLines);
  return result;
}

/** Mỗi chứng từ phải cân: Σ Nợ = Σ Có */
export function assertBalanced(lines: GlLineDraft[]) {
  const byDoc = new Map<string, { dr: Decimal; cr: Decimal }>();
  for (const l of lines) {
    const t = byDoc.get(l.DocNum) ?? { dr: new Decimal(0), cr: new Decimal(0) };
    t.dr = t.dr.plus(l.AccountedDr ?? 0);
    t.cr = t.cr.plus(l.AccountedCr ?? 0);
    byDoc.set(l.DocNum, t);
  }
  for (const [doc, t] of byDoc) {
    if (!t.dr.equals(t.cr)) throw new Error(`Chứng từ ${doc} không cân: Nợ ${t.dr} ≠ Có ${t.cr}`);
  }
}
