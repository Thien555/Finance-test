/**
 * BUILD nguồn ngân hàng / PSP: 1 dòng raw → N AccountingEvent (tài liệu §7.2 AccountingSource, §7.4 PayPal,
 * §7.5 PIPO, §7.6 Stripe).
 *
 * Bốn nguồn có cùng hình dạng nên dùng chung engine này; phần khác nhau nằm trong `BankSourceSpec`
 * (src/lib/engine/sources/*.ts) — thuần khai báo: đọc cột nào, lọc dòng nào, số tiền lấy ở đâu.
 *
 * Trình tự mỗi dòng:
 *  1. `accept`  – lọc theo điều kiện nguồn (PayPal/Stripe chỉ USD, PIPO chỉ Status = Success)
 *  2. ComCode → Company (FncCurr)
 *  3. JournalType: **cột JournalType điền tay thắng**; trống thì suy từ loại giao dịch gốc
 *     (PayPal `Description`, Stripe `Type`, PIPO `Type`) qua `JournalType.JournalType`
 *  4. Resolve tài khoản theo thứ tự: **giá trị trên dòng → MappingBankAccount → mặc định JournalType**
 *  5. Partner theo `JournalType.Partner`: `Fixed = X` hoặc `From Source` (lấy cột PartnerCode của dòng)
 *  6. Mỗi JournalLineRule active → 1 event, `EventSeq = RuleSeq`, `Amount` lấy theo `AmountSource`
 *     (**giữ nguyên dấu, chưa nhân AmountFactor** — Post mới nhân)
 *
 * Chống ghi sổ trùng: với nguồn này 1 dòng raw ⇄ 1 bộ event (khóa `SourceKey` ổn định, không phụ thuộc
 * các cột người dùng điền tay). Người dùng sửa cột JournalType/PartnerCode rồi import lại sẽ bị chặn ngay
 * ở tầng Import (RowHash đổi + BuildStatus = BUILT → bắt Unbuild trước). Vì vậy event không cần `ItemCodes`
 * và build không truyền `deadSourceIds` — dòng biến mất khỏi file chỉ sinh cảnh báo POSTED_SOURCE_CHANGED.
 */
import Decimal from "decimal.js";
import { bankSourceId, periodOf, sha256 } from "./keys";
import { accountFromSource, type MasterIndex, parsePartnerRule } from "./masters";
import { type ResolvedPartner, resolveFixedPartner, resolvePartnerByCode } from "./resolve-partner";
import type { EventDraft, ExceptionDraft, ExceptionType, Severity } from "./types";

/** Số tiền của dòng nguồn theo từng AmountSource của JournalLineRule */
export interface BankAmounts {
  AMOUNT?: Decimal | null;
  GROSS?: Decimal | null;
  FEE?: Decimal | null;
  NET?: Decimal | null;
}

export interface BankAccounts {
  BankGLAccount: string | null;
  ContraAccount: string | null;
  TransAccount: string | null;
  FeeAccount: string | null;
}

export type AcceptResult = { ok: true } | { ok: false; severity: Severity; type: ExceptionType; reason: string };

/** Mô tả 1 nguồn ngân hàng/PSP. Chỉ khai báo cách đọc dòng raw, không chứa quy tắc kế toán. */
export interface BankSourceSpec<R> {
  /** Giá trị AccountingEvent.DataSource — viết HOA để khớp scopeWhere (VD "PAYPAL", "ACCOUNTINGSOURCE") */
  dataSource: string;
  /** Nhãn hiển thị trên UI/exception */
  label: string;
  rowId(row: R): number;
  /** Khóa định danh dòng raw, **không được phụ thuộc các cột người dùng điền tay** */
  sourceKey(row: R): string;
  /**
   * Mã giao dịch gốc ghi lên event/GL (`ReferenceTxnID`, đuôi `Description`). Trống thì dùng `sourceKey`
   * (Bank_Royal không có RefNum). Khóa event đã gồm JournalTypeCode nên mã trùng ở 2 nghiệp vụ khác nhau vẫn hợp lệ.
   */
  transactionId(row: R): string | null;
  accept(row: R): AcceptResult;
  comCode(row: R): string | null;
  /** Cột JournalType điền tay (đã là JournalTypeCode) */
  journalTypeCode(row: R): string | null;
  /** Loại giao dịch gốc của nguồn, dùng khi cột trên trống */
  nativeType(row: R): string | null;
  /** Ngày ghi sổ YYYY-MM-DD */
  postingDate(row: R): string | null;
  /** Tiền tệ giao dịch; null → lấy từ MappingBankAccount, rồi tới FncCurr của công ty */
  inputCurr(row: R): string | null;
  amounts(row: R, journalTypeCode: string): BankAmounts;
  bankAccountNumber(row: R): string | null;
  /** Tài khoản ghi thẳng trên dòng nguồn (Bank_Royal có sẵn 3 TK) — thắng mọi nguồn khác */
  accountOverrides(row: R): Partial<BankAccounts>;
  partnerCode(row: R): string | null;
  storeName(row: R): string | null;
  orderId(row: R): string | null;
  refNum(row: R): string | null;
  /** Diễn giải ghi lên event; mặc định lấy JournalType.JournalType */
  description(row: R): string | null;
}

export type RawBuildStatus = "BUILT" | "SKIPPED" | "ERROR";

export interface BuildBankResult {
  events: EventDraft[];
  exceptions: ExceptionDraft[];
  rawStatus: Map<number, { status: RawBuildStatus; message: string | null; comCode: string | null }>;
  stats: {
    sourceRows: number;
    acceptedRows: number;
    skippedRows: number;
    errorRows: number;
    events: number;
    errorEvents: number;
    zeroAmountSkipped: number;
    ruleSkippedMissingAccount: number;
  };
}

/** JournalLineRule.AmountSource → số tiền của dòng nguồn. Trả `undefined` khi nguồn không có AmountSource đó. */
export function amountFromSource(source: string | null | undefined, amounts: BankAmounts): Decimal | null | undefined {
  switch ((source ?? "").trim().toUpperCase()) {
    case "AMOUNT":
      return amounts.AMOUNT;
    case "GROSS":
      return amounts.GROSS;
    case "FEE":
      return amounts.FEE;
    case "NET":
      return amounts.NET;
    default:
      return undefined;
  }
}

/**
 * Gom exception theo nhóm thay vì ghi từng dòng: nguồn PayPal có 142k dòng, riêng rule bị bỏ vì thiếu
 * TransAccount đã là ~86k dòng — ghi từng dòng thì màn Exceptions vô dụng và DB phình.
 * Chi tiết từng dòng vẫn nằm ở `RawXxx.BuildMessage` (xem được trên trang raw).
 */
class ExceptionBag {
  private map = new Map<string, { draft: ExceptionDraft; count: number; samples: string[] }>();

  constructor(private readonly dataSource: string) {}

  add(
    e: { severity: Severity; type: ExceptionType; comCode: string | null; sourceKey: string; message: string },
    sample?: string | null,
  ) {
    const key = [e.type, e.severity, e.comCode ?? "", e.sourceKey].join("");
    const hit = this.map.get(key);
    if (hit) {
      hit.count++;
      if (sample && hit.samples.length < 3) hit.samples.push(sample);
      return;
    }
    this.map.set(key, {
      draft: {
        DataSource: this.dataSource,
        ComCode: e.comCode,
        Period: null,
        Severity: e.severity,
        ExceptionType: e.type,
        SourceKey: e.sourceKey,
        Message: e.message,
      },
      count: 1,
      samples: sample ? [sample] : [],
    });
  }

  list(): ExceptionDraft[] {
    return [...this.map.values()].map(({ draft, count, samples }) => ({
      ...draft,
      Message:
        count === 1 && samples.length <= 1
          ? `${draft.Message}${samples[0] ? ` (${samples[0]})` : ""}`
          : `${draft.Message} — ${count} dòng${samples.length ? ` (VD: ${samples.join(", ")}${count > samples.length ? "…" : ""})` : ""}`,
    }));
  }
}

const round2 = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function buildBankEvents<R>(rows: R[], spec: BankSourceSpec<R>, index: MasterIndex): BuildBankResult {
  const bag = new ExceptionBag(spec.dataSource);
  const rawStatus: BuildBankResult["rawStatus"] = new Map();
  const events: EventDraft[] = [];
  let acceptedRows = 0;
  let skippedRows = 0;
  let errorRows = 0;
  let zeroAmountSkipped = 0;
  let ruleSkippedMissingAccount = 0;

  for (const row of rows) {
    const rowId = spec.rowId(row);
    const sourceKey = spec.sourceKey(row);
    const comCode = spec.comCode(row)?.trim().toUpperCase() || null;

    const fail = (type: ExceptionType, groupKey: string, message: string) => {
      errorRows++;
      rawStatus.set(rowId, { status: "ERROR", message, comCode });
      bag.add({ severity: "ERROR", type, comCode, sourceKey: groupKey, message }, sourceKey);
    };

    // ── 1. Lọc theo điều kiện của nguồn ──
    const accepted = spec.accept(row);
    if (!accepted.ok) {
      skippedRows++;
      rawStatus.set(rowId, { status: "SKIPPED", message: accepted.reason, comCode });
      bag.add(
        { severity: accepted.severity, type: accepted.type, comCode, sourceKey: `${spec.dataSource}|${accepted.reason}`, message: accepted.reason },
        sourceKey,
      );
      continue;
    }

    // ── 2. ComCode → Company ──
    if (!comCode) {
      fail("MISSING_COMCODE", `${spec.dataSource}|MISSING_COMCODE`, `Dòng nguồn ${spec.label} không có ComCode`);
      continue;
    }
    const company = index.company(comCode);
    if (!company) {
      fail("MISSING_COMPANY", comCode, `ComCode ${comCode} chưa có trong bảng Company`);
      continue;
    }

    // ── 3. Ngày ghi sổ ──
    const postingDate = spec.postingDate(row);
    if (!postingDate) {
      fail("INVALID_SOURCE_ROW", `${spec.dataSource}|PostingDate`, `Dòng nguồn ${spec.label} không đọc được ngày ghi sổ`);
      continue;
    }
    const period = periodOf(postingDate);

    // ── 4. JournalType: cột điền tay thắng, trống thì suy từ loại giao dịch gốc ──
    const manualCode = spec.journalTypeCode(row)?.trim() || null;
    const nativeType = spec.nativeType(row)?.trim() || null;
    const jt = manualCode
      ? index.journalType(spec.dataSource, manualCode)
      : index.journalTypeByNativeType(spec.dataSource, nativeType);
    if (!jt) {
      const wanted = manualCode ?? nativeType;
      fail(
        "MISSING_JOURNAL_TYPE",
        wanted ?? `${spec.dataSource}|EMPTY`,
        manualCode
          ? `Không có JournalType DataSource=${spec.dataSource}, JournalTypeCode=${manualCode}`
          : nativeType
            ? `Cột JournalType để trống và không map được loại giao dịch "${nativeType}" (DataSource=${spec.dataSource})`
            : `Dòng nguồn ${spec.label} không có JournalType và cũng không có loại giao dịch gốc để suy ra`,
      );
      continue;
    }
    const jtc = jt.JournalTypeCode;

    const rules = index.activeRules(jtc);
    if (rules.length === 0) {
      fail("MISSING_RULE", jtc, `Không có JournalLineRule active cho ${jtc}`);
      continue;
    }

    // ── 5. Tài khoản: dòng nguồn → MappingBankAccount → mặc định JournalType ──
    const bankAccountNumber = spec.bankAccountNumber(row)?.trim() || null;
    const mapping = index.bankMapping(comCode, bankAccountNumber);
    const overrides = spec.accountOverrides(row);
    const accounts: BankAccounts = {
      BankGLAccount: overrides.BankGLAccount ?? mapping?.GLAccountCode ?? jt.BankAccount,
      ContraAccount: overrides.ContraAccount ?? jt.ContraAccount,
      TransAccount: overrides.TransAccount ?? jt.TransAccount,
      FeeAccount: overrides.FeeAccount ?? jt.FeeAccount,
    };
    const inputCurr = (spec.inputCurr(row)?.trim() || mapping?.InputCurr?.trim() || company.FunctionalCurrency).toUpperCase();

    // ── 6. Partner ──
    let partner: ResolvedPartner = { PartnerCode: null, PartnerTaxID: null, PartnerName: null };
    const partnerRule = parsePartnerRule(jt.Partner);
    if (partnerRule.mode === "FIXED") {
      partner = resolveFixedPartner(index, partnerRule.code);
    } else if (partnerRule.mode === "FROM_SOURCE") {
      const code = spec.partnerCode(row);
      const res = resolvePartnerByCode(index, code, spec.storeName(row));
      partner = res.partner;
      if (!res.matched) {
        bag.add(
          {
            severity: "WARNING",
            type: "MISSING_PARTNER",
            comCode,
            sourceKey: `${jtc}|${code?.trim() ?? ""}`,
            message: code?.trim()
              ? `PartnerCode "${code.trim()}" (${jtc}) chưa có trong Partners → ghi sổ với mã đó, PartnerTaxID trống`
              : `Dòng ${jtc} dùng partner "From Source" nhưng cột PartnerCode để trống`,
          },
          sourceKey,
        );
      } else if (res.ambiguous) {
        bag.add(
          {
            severity: "WARNING",
            type: "MISSING_PARTNER",
            comCode,
            sourceKey: `${jtc}|${code?.trim() ?? ""}|AMBIGUOUS`,
            message: `PartnerCode "${code?.trim()}" ứng với nhiều partner, StoreName không tách được → lấy dòng có PartnerTaxID`,
          },
          sourceKey,
        );
      }
    }

    // ── 7. Mỗi rule active → 1 event ──
    const amounts = spec.amounts(row, jtc);
    const description = spec.description(row) ?? jt.JournalType;
    const transactionId = spec.transactionId(row)?.trim() || sourceKey;
    let emitted = 0;
    const rowNotes: string[] = [];

    for (const rule of rules) {
      const amount = amountFromSource(rule.AmountSource, amounts);
      if (amount === undefined) {
        bag.add({
          severity: "ERROR",
          type: "UNKNOWN_AMOUNT_SOURCE",
          comCode,
          sourceKey: `${jtc}|${rule.RuleSeq}`,
          message: `AmountSource "${rule.AmountSource}" không áp dụng cho nguồn ${spec.label}`,
        });
        continue;
      }
      const amountValue = round2(amount ?? new Decimal(0));

      if (amountValue.isZero() && rule.SkipIfAmountZero) {
        zeroAmountSkipped++;
        rowNotes.push(`rule ${rule.RuleSeq}: ${rule.AmountSource} = 0`);
        bag.add({
          severity: "INFO",
          type: "AMOUNT_ZERO",
          comCode,
          sourceKey: `${jtc}|${rule.RuleSeq}`,
          message: `${jtc} rule ${rule.RuleSeq}: ${rule.AmountSource} = 0 → bỏ qua (SkipIfAmountZero)`,
        });
        continue;
      }

      const drAccount = accountFromSource(rule.NormalDrAccountSource, accounts);
      const crAccount = accountFromSource(rule.NormalCrAccountSource, accounts);
      if ((!drAccount && rule.SkipIfDrAccountNull) || (!crAccount && rule.SkipIfCrAccountNull)) {
        ruleSkippedMissingAccount++;
        const missing = !drAccount ? rule.NormalDrAccountSource : rule.NormalCrAccountSource;
        rowNotes.push(`rule ${rule.RuleSeq}: thiếu ${missing}`);
        bag.add({
          severity: "INFO",
          type: "MISSING_ACCOUNT",
          comCode,
          sourceKey: `${jtc}|${rule.RuleSeq}`,
          message: `${jtc} rule ${rule.RuleSeq}: JournalType không khai ${missing} → bỏ qua rule (SkipIf${!drAccount ? "Dr" : "Cr"}AccountNull)`,
        });
        continue;
      }

      events.push({
        ComCode: comCode,
        DataSource: spec.dataSource,
        JournalTypeCode: jtc,
        TransactionID: transactionId,
        EventSeq: rule.RuleSeq,
        LineSeq: 1,
        PairCode: rule.PairCode,
        AmountSource: rule.AmountSource,
        PostingDate: postingDate,
        Period: period,
        OrderID: spec.orderId(row),
        RefNum: spec.refNum(row),
        SourceID: bankSourceId(spec.dataSource, sourceKey),
        InputCurr: inputCurr,
        FncCurr: company.FunctionalCurrency,
        Amount: amountValue.toNumber(),
        BankAccountNumber: bankAccountNumber,
        BankGLAccount: accounts.BankGLAccount,
        ContraAccount: accounts.ContraAccount,
        TransAccount: accounts.TransAccount,
        FeeAccount: accounts.FeeAccount,
        PartnerCode: partner.PartnerCode,
        PartnerTaxID: partner.PartnerTaxID,
        PartnerName: partner.PartnerName,
        Description: description,
        BalanceImpact: null,
        PostStatus: "NEW",
        ErrorStage: null,
        ErrorMessage: null,
        SourceHash: sha256({
          comCode,
          dataSource: spec.dataSource,
          sourceKey,
          jtc,
          ruleSeq: rule.RuleSeq,
          postingDate,
          inputCurr,
          amount: amountValue.toFixed(2),
          accounts,
          partner,
        }),
        ItemCodes: null,
        rawRowIds: [rowId],
      });
      emitted++;
    }

    acceptedRows++;
    rawStatus.set(rowId, {
      status: "BUILT",
      message: emitted === 0 ? `Không sinh event nào — ${rowNotes.join("; ") || "mọi rule bị bỏ qua"}` : rowNotes.join("; ") || null,
      comCode,
    });
  }

  return {
    events,
    exceptions: bag.list(),
    rawStatus,
    stats: {
      sourceRows: rows.length,
      acceptedRows,
      skippedRows,
      errorRows,
      events: events.length,
      errorEvents: events.filter((e) => e.PostStatus === "ERROR").length,
      zeroAmountSkipped,
      ruleSkippedMissingAccount,
    },
  };
}
