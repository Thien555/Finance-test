/**
 * BUILD ORDERS: RawOrders → AccountingEvent (tài liệu §7.3)
 *
 *  1. Chỉ lấy ItemStatus = FULFILLED và có FulfilledAt
 *  2. ComCode = GatewayCompanyMapping(PaymentGatewayName); FncCurr = Company.FunctionalCurrency; InputCurr = USD
 *  3. PostingDate = FulfilledAt ; Period = YYYYMM
 *  4. Group theo ComCode + OrderId + PostingDate, cộng:
 *       PRODUCT       = Σ Quantity × UnitPrice
 *       SHIPADD       = Σ ShippingFee + AdditionalCost
 *       TAX           = Σ TaxFee
 *       SELLER_PROFIT = Σ Profit
 *  5. Mỗi JournalTypeCode × mỗi JournalLineRule active → 1 AccountingEvent (EventSeq = RuleSeq)
 */
import Decimal from "decimal.js";
import type { RawOrderRow } from "@/lib/db/schema";
import { orderSourceId, orderTransactionId, periodOf, sha256 } from "./keys";
import { accountFromSource, type MasterIndex, parsePartnerRule } from "./masters";
import { type ResolvedPartner, resolveFixedPartner, resolveSeller } from "./resolve-partner";
import type { EventDraft, ExceptionDraft } from "./types";

export const ORDERS_DATA_SOURCE = "ORDERS";
export const ORDER_INPUT_CURRENCY = "USD";

/** 4 nghiệp vụ sinh ra từ 1 order fulfilled */
export const ORDER_JOURNAL_TYPE_CODES = [
  "ORD_REV_PRODUCT_FULFILLED",
  "ORD_REV_SHIPADD_FULFILLED",
  "ORD_REV_TAX_FULFILLED",
  "ORD_SELLER_PROFIT_FULFILLED",
] as const;

export type OrderSourceRow = Pick<
  RawOrderRow,
  | "RawOrderID"
  | "OrderId"
  | "ItemCode"
  | "ItemStatus"
  | "FulfilledAt"
  | "Quantity"
  | "UnitPrice"
  | "ShippingFee"
  | "AdditionalCost"
  | "TaxFee"
  | "Profit"
  | "SellerEmail"
  | "TaxID"
  | "StoreName"
  | "PaymentGatewayName"
>;

interface OrderGroup {
  comCode: string;
  fncCurr: string;
  orderId: string;
  postingDate: string;
  product: Decimal;
  shipAdd: Decimal;
  tax: Decimal;
  profit: Decimal;
  sellerEmail: string | null;
  taxId: string | null;
  storeName: string | null;
  itemCodes: string[];
  rawOrderIds: number[];
}

export type RawBuildStatus = "BUILT" | "SKIPPED" | "ERROR";

export interface BuildOrdersResult {
  events: EventDraft[];
  exceptions: ExceptionDraft[];
  /** Trạng thái build của từng dòng raw */
  rawStatus: Map<number, { status: RawBuildStatus; message: string | null; comCode: string | null }>;
  stats: {
    sourceRows: number;
    fulfilledRows: number;
    skippedRows: number;
    errorRows: number;
    groups: number;
    events: number;
    errorEvents: number;
    zeroAmountSkipped: number;
  };
}

const d = (v: number | null | undefined) => new Decimal(v ?? 0);

/** Dòng đủ điều kiện ghi nhận doanh thu: ItemStatus = FULFILLED và có FulfilledAt */
function isFulfilled<T extends Pick<OrderSourceRow, "ItemStatus" | "FulfilledAt">>(row: T): row is T & { FulfilledAt: string } {
  return (row.ItemStatus ?? "").trim().toUpperCase() === "FULFILLED" && !!row.FulfilledAt;
}

/**
 * Dòng raw cần build khi chọn phạm vi ComCode: build TRỌN đơn (OrderId + ngày giao = SourceID), không build lẻ dòng.
 *  - Mọi dòng đang map vào ComCode đó (theo GatewayCompanyMapping hiện tại);
 *  - Cộng mọi dòng khác của SourceID có dòng map vào ComCode đó, hoặc đang có event của ComCode đó (`scopeEventSourceIds`
 *    – mapping đã đổi đi nơi khác).
 * Nhờ vậy đơn đi qua nhiều cổng/công ty luôn được đối chiếu đủ event của mọi ComCode, không bỏ sót event cũ.
 * Không chọn ComCode → toàn bộ dòng.
 */
export function orderRowsInScope<R extends Pick<OrderSourceRow, "OrderId" | "FulfilledAt" | "PaymentGatewayName">>(
  periodRows: R[],
  index: MasterIndex,
  scopeComCode: string | null,
  scopeEventSourceIds: Iterable<string> = [],
): R[] {
  if (!scopeComCode) return periodRows;
  const inScope = (r: R) => index.comCodeOfGateway(r.PaymentGatewayName) === scopeComCode;
  const sourceIds = new Set(scopeEventSourceIds);
  for (const r of periodRows) if (r.FulfilledAt && inScope(r)) sourceIds.add(orderSourceId(r.OrderId, r.FulfilledAt));
  return periodRows.filter((r) => inScope(r) || (!!r.FulfilledAt && sourceIds.has(orderSourceId(r.OrderId, r.FulfilledAt))));
}

/** AmountSource trong JournalLineRule → số tiền của group */
function amountFor(source: string | null, g: OrderGroup): Decimal | null {
  switch ((source ?? "").trim().toUpperCase()) {
    case "PRODUCT":
      return g.product;
    case "SHIPADD":
      return g.shipAdd;
    case "TAX":
      return g.tax;
    case "SELLER_PROFIT":
    case "PROFIT":
      return g.profit;
    default:
      return null;
  }
}

export function buildOrderEvents(rows: OrderSourceRow[], index: MasterIndex): BuildOrdersResult {
  const exceptions: ExceptionDraft[] = [];
  const rawStatus: BuildOrdersResult["rawStatus"] = new Map();
  const groups = new Map<string, OrderGroup>();
  let skippedRows = 0;
  let errorRows = 0;

  const ex = (e: Omit<ExceptionDraft, "DataSource">) => exceptions.push({ DataSource: ORDERS_DATA_SOURCE, ...e });

  // ── Bước 1-4: lọc, resolve ComCode, group ──
  for (const row of rows) {
    const comCode = index.comCodeOfGateway(row.PaymentGatewayName);
    if (!isFulfilled(row)) {
      skippedRows++;
      const message = `ItemStatus=${row.ItemStatus ?? ""}${row.FulfilledAt ? "" : ", FulfilledAt trống"} → không ghi nhận doanh thu`;
      rawStatus.set(row.RawOrderID, { status: "SKIPPED", message, comCode: comCode ?? null });
      ex({
        ComCode: comCode ?? null,
        Period: row.FulfilledAt ? periodOf(row.FulfilledAt) : null,
        Severity: "INFO",
        ExceptionType: "NOT_FULFILLED",
        SourceKey: row.ItemCode,
        Message: message,
      });
      continue;
    }

    const postingDate = row.FulfilledAt.slice(0, 10);
    const period = periodOf(postingDate);
    if (!comCode) {
      errorRows++;
      const message = `Chưa map PaymentGatewayName "${row.PaymentGatewayName ?? ""}" sang ComCode (Master → GatewayCompanyMapping)`;
      rawStatus.set(row.RawOrderID, { status: "ERROR", message, comCode: null });
      ex({ ComCode: null, Period: period, Severity: "ERROR", ExceptionType: "MISSING_COMCODE", SourceKey: row.ItemCode, Message: message });
      continue;
    }
    const company = index.company(comCode);
    if (!company) {
      errorRows++;
      const message = `ComCode ${comCode} chưa có trong bảng Company`;
      rawStatus.set(row.RawOrderID, { status: "ERROR", message, comCode });
      ex({ ComCode: comCode, Period: period, Severity: "ERROR", ExceptionType: "MISSING_COMPANY", SourceKey: row.ItemCode, Message: message });
      continue;
    }

    const key = `${comCode}|${row.OrderId}|${postingDate}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        comCode,
        fncCurr: company.FunctionalCurrency,
        orderId: row.OrderId,
        postingDate,
        product: new Decimal(0),
        shipAdd: new Decimal(0),
        tax: new Decimal(0),
        profit: new Decimal(0),
        sellerEmail: row.SellerEmail,
        taxId: row.TaxID,
        storeName: row.StoreName,
        itemCodes: [],
        rawOrderIds: [],
      };
      groups.set(key, g);
    }
    g.product = g.product.plus(d(row.Quantity).times(d(row.UnitPrice)));
    g.shipAdd = g.shipAdd.plus(d(row.ShippingFee)).plus(d(row.AdditionalCost));
    g.tax = g.tax.plus(d(row.TaxFee));
    g.profit = g.profit.plus(d(row.Profit));
    g.itemCodes.push(row.ItemCode);
    g.rawOrderIds.push(row.RawOrderID);
    rawStatus.set(row.RawOrderID, { status: "BUILT", message: null, comCode });
  }

  // ── Bước 5: sinh event theo JournalType + JournalLineRule ──
  const events: EventDraft[] = [];
  const reportedConfig = new Set<string>();
  let zeroAmountSkipped = 0;

  const configError = (type: "MISSING_JOURNAL_TYPE" | "MISSING_RULE" | "UNKNOWN_AMOUNT_SOURCE", key: string, message: string) => {
    if (reportedConfig.has(`${type}|${key}`)) return;
    reportedConfig.add(`${type}|${key}`);
    ex({ ComCode: null, Period: null, Severity: "ERROR", ExceptionType: type, SourceKey: key, Message: message });
  };

  for (const g of groups.values()) {
    const period = periodOf(g.postingDate);
    const transactionId = orderTransactionId(g.orderId, g.postingDate);

    for (const jtc of ORDER_JOURNAL_TYPE_CODES) {
      const jt = index.journalType(ORDERS_DATA_SOURCE, jtc);
      if (!jt) {
        configError("MISSING_JOURNAL_TYPE", jtc, `Không có JournalType DataSource=ORDERS, JournalTypeCode=${jtc}`);
        continue;
      }
      const rules = index.activeRules(jtc);
      if (rules.length === 0) {
        configError("MISSING_RULE", jtc, `Không có JournalLineRule active cho ${jtc}`);
        continue;
      }

      for (const rule of rules) {
        const amount = amountFor(rule.AmountSource, g);
        if (amount === null) {
          configError("UNKNOWN_AMOUNT_SOURCE", `${jtc}|${rule.RuleSeq}`, `AmountSource "${rule.AmountSource}" không áp dụng cho Orders`);
          continue;
        }
        const amountValue = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        if (amountValue.isZero() && rule.SkipIfAmountZero) {
          zeroAmountSkipped++;
          ex({
            ComCode: g.comCode,
            Period: period,
            Severity: "INFO",
            ExceptionType: "AMOUNT_ZERO",
            SourceKey: `${transactionId}|${jtc}`,
            Message: `${rule.AmountSource} = 0 → bỏ qua (SkipIfAmountZero)`,
          });
          continue;
        }

        const accounts = {
          BankGLAccount: jt.BankAccount,
          ContraAccount: jt.ContraAccount,
          TransAccount: jt.TransAccount,
          FeeAccount: jt.FeeAccount,
        };
        const drAccount = accountFromSource(rule.NormalDrAccountSource, accounts);
        const crAccount = accountFromSource(rule.NormalCrAccountSource, accounts);
        if ((!drAccount && rule.SkipIfDrAccountNull) || (!crAccount && rule.SkipIfCrAccountNull)) {
          ex({
            ComCode: g.comCode,
            Period: period,
            Severity: "WARNING",
            ExceptionType: "MISSING_ACCOUNT",
            SourceKey: `${transactionId}|${jtc}`,
            Message: `Thiếu TK ${!drAccount ? rule.NormalDrAccountSource : rule.NormalCrAccountSource} trên JournalType ${jtc} → bỏ qua rule`,
          });
          continue;
        }

        // Partner
        let partner: ResolvedPartner = { PartnerCode: null, PartnerTaxID: null, PartnerName: null };
        let errorMessage: string | null = null;
        const partnerRule = parsePartnerRule(jt.Partner);
        if (partnerRule.mode === "FIXED") {
          partner = resolveFixedPartner(index, partnerRule.code);
        } else if (partnerRule.mode === "FROM_SOURCE") {
          const res = resolveSeller(index, { taxId: g.taxId, sellerEmail: g.sellerEmail, storeName: g.storeName });
          if (res.ok) {
            partner = res.partner;
          } else {
            errorMessage = res.error;
            partner = { PartnerCode: g.sellerEmail, PartnerTaxID: g.taxId, PartnerName: null };
            ex({
              ComCode: g.comCode,
              Period: period,
              Severity: "ERROR",
              ExceptionType: "MISSING_PARTNER",
              SourceKey: `${transactionId}|${jtc}`,
              Message: res.error,
            });
          }
        }

        events.push({
          ComCode: g.comCode,
          DataSource: ORDERS_DATA_SOURCE,
          JournalTypeCode: jt.JournalTypeCode,
          TransactionID: transactionId,
          EventSeq: rule.RuleSeq,
          LineSeq: 1,
          PairCode: rule.PairCode,
          AmountSource: rule.AmountSource,
          PostingDate: g.postingDate,
          Period: period,
          OrderID: g.orderId,
          RefNum: g.orderId,
          SourceID: orderSourceId(g.orderId, g.postingDate),
          InputCurr: ORDER_INPUT_CURRENCY,
          FncCurr: g.fncCurr,
          Amount: amountValue.toNumber(),
          BankAccountNumber: null,
          BankGLAccount: accounts.BankGLAccount,
          ContraAccount: accounts.ContraAccount,
          TransAccount: accounts.TransAccount,
          FeeAccount: accounts.FeeAccount,
          PartnerCode: partner.PartnerCode,
          PartnerTaxID: partner.PartnerTaxID,
          PartnerName: partner.PartnerName,
          Description: jt.JournalType,
          BalanceImpact: null,
          PostStatus: errorMessage ? "ERROR" : "NEW",
          ErrorStage: errorMessage ? "BUILD" : null,
          ErrorMessage: errorMessage,
          SourceHash: sha256({
            comCode: g.comCode,
            orderId: g.orderId,
            postingDate: g.postingDate,
            jtc,
            ruleSeq: rule.RuleSeq,
            amount: amountValue.toFixed(2),
            partner,
            items: [...g.itemCodes].sort(),
          }),
          ItemCodes: JSON.stringify([...g.itemCodes].sort()),
          rawOrderIds: g.rawOrderIds,
        });
      }
    }
  }

  return {
    events,
    exceptions,
    rawStatus,
    stats: {
      sourceRows: rows.length,
      fulfilledRows: rows.length - skippedRows - errorRows,
      skippedRows,
      errorRows,
      groups: groups.size,
      events: events.length,
      errorEvents: events.filter((e) => e.PostStatus === "ERROR").length,
      zeroAmountSkipped,
    },
  };
}
