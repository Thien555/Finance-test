/** Truy vấn đọc cho các màn hình (danh sách có filter + phân trang, dashboard, drill-down). */
import { and, asc, count, desc, eq, gte, inArray, like, lte, or, type SQL, sql, sum } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  accountingEvent,
  buildBatch,
  coa,
  company,
  exceptionLog,
  exrate,
  gatewayCompanyMapping,
  glTrans,
  importBatch,
  journalLineRule,
  journalType,
  mappingBankAccount,
  partners,
  postingBatch,
  rawOrders,
  rawPaypal,
  rawPipo,
  rawStripe,
} from "@/lib/db/schema";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { SOURCE_META, type SourceKey } from "@/lib/sources/columns";
import { periodOfDateColumn, type Scope, scopeWhere } from "./common";

export interface Paging {
  page?: number;
  pageSize?: number;
}

const paging = (p: Paging) => {
  const pageSize = Math.min(Math.max(p.pageSize ?? 50, 1), 5000);
  const page = Math.max(p.page ?? 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize };
};

const likeAny = (text: string | null | undefined, ...cols: Parameters<typeof like>[0][]) =>
  text ? or(...cols.map((c) => like(c, `%${text.trim()}%`))) : undefined;

const whereOf = (conds: (SQL | undefined)[]) => {
  const list = conds.filter((c): c is SQL => !!c);
  return list.length ? and(...list) : undefined;
};

// ───────────── GLTrans ─────────────

export interface GlFilter extends Scope, Paging {
  journalTypeCode?: string | null;
  accountCode?: string | null;
  docNum?: string | null;
  postBatchId?: number | null;
  partner?: string | null;
  balanceImpact?: string | null;
}

export function glWhere(f: GlFilter) {
  return whereOf([
    ...scopeWhere(glTrans, f),
    f.journalTypeCode ? eq(glTrans.JournalTypeCode, f.journalTypeCode) : undefined,
    f.accountCode ? like(glTrans.AccountCode, `${f.accountCode.trim()}%`) : undefined,
    f.docNum ? like(glTrans.DocNum, `%${f.docNum.trim()}%`) : undefined,
    f.postBatchId ? eq(glTrans.PostBatchID, f.postBatchId) : undefined,
    likeAny(f.partner, glTrans.PartnerCode, glTrans.PartnerTaxID),
    f.balanceImpact ? eq(glTrans.BalanceImpact, f.balanceImpact) : undefined,
  ]);
}

export function listGl(f: GlFilter) {
  const db = getDb();
  const where = glWhere(f);
  const { limit, offset } = paging(f);
  const rows = db.select().from(glTrans).where(where).orderBy(asc(glTrans.TransDate), asc(glTrans.ID)).limit(limit).offset(offset).all();
  const [t] = db
    .select({
      total: count(),
      InputDr: sum(glTrans.InputDr),
      InputCr: sum(glTrans.InputCr),
      AccountedDr: sum(glTrans.AccountedDr),
      AccountedCr: sum(glTrans.AccountedCr),
      Documents: sql<number>`count(distinct ${glTrans.DocNum})`,
    })
    .from(glTrans)
    .where(where)
    .all();
  const num = (v: string | null) => Math.round(Number(v ?? 0) * 100) / 100;
  return {
    rows,
    total: t.total,
    totals: {
      Documents: t.Documents,
      InputDr: num(t.InputDr),
      InputCr: num(t.InputCr),
      AccountedDr: num(t.AccountedDr),
      AccountedCr: num(t.AccountedCr),
    },
  };
}

export function allGl(f: GlFilter) {
  return getDb().select().from(glTrans).where(glWhere(f)).orderBy(asc(glTrans.TransDate), asc(glTrans.ID)).all();
}

/** Tổng hợp theo tài khoản (giống bảng cân đối phát sinh mini) */
export function glAccountSummary(f: GlFilter) {
  const db = getDb();
  return db
    .select({
      AccountCode: glTrans.AccountCode,
      AccountName: coa.AccountName,
      AccountType: coa.AccountType,
      Lines: count(),
      AccountedDr: sql<number>`round(sum(${glTrans.AccountedDr}), 2)`,
      AccountedCr: sql<number>`round(sum(${glTrans.AccountedCr}), 2)`,
      Balance: sql<number>`round(sum(${glTrans.AccountedDr}) - sum(${glTrans.AccountedCr}), 2)`,
    })
    .from(glTrans)
    .leftJoin(coa, eq(coa.AccountCode, glTrans.AccountCode))
    .where(glWhere(f))
    .groupBy(glTrans.AccountCode)
    .orderBy(asc(glTrans.AccountCode))
    .all();
}

/** Drill-down 1 chứng từ: GL → AccountingEvent → RawOrders */
export function glDocumentDetail(docNum: string) {
  const db = getDb();
  const lines = db.select().from(glTrans).where(eq(glTrans.DocNum, docNum)).orderBy(asc(glTrans.ID)).all();
  const events = db.select().from(accountingEvent).where(eq(accountingEvent.PostedDocNum, docNum)).orderBy(asc(accountingEvent.AccountingEventID)).all();
  // Chỉ nguồn ORDERS mới truy được về RawOrders; nguồn ngân hàng/PSP có bảng raw riêng
  const orderIds = [
    ...new Set(
      events.filter((e) => e.DataSource === ORDERS_DATA_SOURCE).map((e) => e.OrderID).filter((x): x is string => !!x),
    ),
  ].slice(0, 500);
  const orders = orderIds.length
    ? db.select().from(rawOrders).where(inArray(rawOrders.OrderId, orderIds)).orderBy(asc(rawOrders.OrderId)).all()
    : [];
  return { docNum, lines, events, orders };
}

// ───────────── AccountingEvent ─────────────

export interface EventFilter extends Scope, Paging {
  journalTypeCode?: string | null;
  postStatus?: string | null;
  search?: string | null;
  postBatchId?: number | null;
}

function eventWhere(f: EventFilter) {
  return whereOf([
    ...scopeWhere(accountingEvent, f),
    f.journalTypeCode ? eq(accountingEvent.JournalTypeCode, f.journalTypeCode) : undefined,
    f.postStatus ? eq(accountingEvent.PostStatus, f.postStatus) : undefined,
    f.postBatchId ? eq(accountingEvent.PostBatchID, f.postBatchId) : undefined,
    likeAny(
      f.search,
      accountingEvent.TransactionID,
      accountingEvent.OrderID,
      accountingEvent.PartnerCode,
      accountingEvent.PartnerName,
      accountingEvent.PostedDocNum,
    ),
  ]);
}

export function listEvents(f: EventFilter) {
  const db = getDb();
  const where = eventWhere(f);
  const { limit, offset } = paging(f);
  const rows = db.select().from(accountingEvent).where(where).orderBy(asc(accountingEvent.AccountingEventID)).limit(limit).offset(offset).all();
  const [{ total }] = db.select({ total: count() }).from(accountingEvent).where(where).all();
  const summary = db
    .select({
      JournalTypeCode: accountingEvent.JournalTypeCode,
      PostStatus: accountingEvent.PostStatus,
      Events: count(),
      Amount: sql<number>`round(sum(${accountingEvent.Amount}), 2)`,
    })
    .from(accountingEvent)
    .where(where)
    .groupBy(accountingEvent.JournalTypeCode, accountingEvent.PostStatus)
    .orderBy(asc(accountingEvent.JournalTypeCode))
    .all();
  return { rows, total, summary };
}

export function allEvents(f: EventFilter) {
  return getDb().select().from(accountingEvent).where(eventWhere(f)).orderBy(asc(accountingEvent.AccountingEventID)).all();
}

export function eventDetail(id: number) {
  const db = getDb();
  const event = db.select().from(accountingEvent).where(eq(accountingEvent.AccountingEventID, id)).get();
  if (!event) return null;
  const orders =
    event.OrderID && event.DataSource === ORDERS_DATA_SOURCE
      ? db
        .select()
        .from(rawOrders)
        .where(and(eq(rawOrders.OrderId, event.OrderID), eq(rawOrders.FulfilledAt, event.PostingDate)))
        .all()
      : [];
  const rule = db
    .select()
    .from(journalLineRule)
    .where(and(eq(journalLineRule.JournalTypeCode, event.JournalTypeCode), eq(journalLineRule.RuleSeq, event.EventSeq)))
    .get();
  const jt = db
    .select()
    .from(journalType)
    .where(and(eq(journalType.DataSource, event.DataSource), eq(journalType.JournalTypeCode, event.JournalTypeCode)))
    .get();
  const glLines = event.PostedDocNum ? db.select().from(glTrans).where(eq(glTrans.DocNum, event.PostedDocNum)).all() : [];
  return { event, orders, rule: rule ?? null, journalType: jt ?? null, glLines };
}

// ───────────── Raw / batches / exceptions ─────────────

export interface RawFilter extends Paging {
  search?: string | null;
  comCode?: string | null;
  itemStatus?: string | null;
  buildStatus?: string | null;
  importBatchId?: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
}

export function listRawOrders(f: RawFilter) {
  const db = getDb();
  const where = whereOf([
    likeAny(f.search, rawOrders.OrderId, rawOrders.ItemCode, rawOrders.SellerEmail, rawOrders.StoreName),
    f.comCode ? eq(rawOrders.ComCode, f.comCode) : undefined,
    f.itemStatus ? eq(rawOrders.ItemStatus, f.itemStatus) : undefined,
    f.buildStatus ? eq(rawOrders.BuildStatus, f.buildStatus) : undefined,
    f.importBatchId ? eq(rawOrders.ImportBatchID, f.importBatchId) : undefined,
    f.periodFrom ? gte(periodOfDateColumn(rawOrders.FulfilledAt), f.periodFrom) : undefined,
    f.periodTo ? lte(periodOfDateColumn(rawOrders.FulfilledAt), f.periodTo) : undefined,
  ]);
  const { limit, offset } = paging(f);
  const rows = db.select().from(rawOrders).where(where).orderBy(asc(rawOrders.RawOrderID)).limit(limit).offset(offset).all();
  const [{ total }] = db.select({ total: count() }).from(rawOrders).where(where).all();
  return { rows, total };
}

/** Bảng raw của các nguồn ngoài Orders — mọi bảng đều có cùng bộ cột quản trị nên dùng chung 1 hàm */
const RAW_SOURCE_TABLES = {
  paypal: { table: rawPaypal, id: rawPaypal.RawPaypalID, search: [rawPaypal.SourceKey, rawPaypal.TransactionID, rawPaypal.InvoiceID, rawPaypal.PartnerCode, rawPaypal.StoreName] },
  stripe: { table: rawStripe, id: rawStripe.RawStripeID, search: [rawStripe.SourceKey, rawStripe.Id, rawStripe.MetaInvoiceId, rawStripe.PartnerCode, rawStripe.StoreName] },
  pipo: { table: rawPipo, id: rawPipo.RawPipoID, search: [rawPipo.SourceKey, rawPipo.TransactionId, rawPipo.PartnerCode, rawPipo.StoreName, rawPipo.FromTo] },
} as const;

export interface RawSourceFilter extends Paging {
  search?: string | null;
  comCode?: string | null;
  buildStatus?: string | null;
  journalType?: string | null;
  importBatchId?: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
}

export function listRawSource(source: SourceKey, f: RawSourceFilter) {
  const db = getDb();
  const { table, id, search } = RAW_SOURCE_TABLES[source];
  const t = table as unknown as (typeof rawPaypal);
  const where = whereOf([
    likeAny(f.search, ...(search as unknown as Parameters<typeof like>[0][])),
    f.comCode ? eq(t.ComCode, f.comCode) : undefined,
    f.buildStatus ? eq(t.BuildStatus, f.buildStatus) : undefined,
    f.journalType ? eq(t.JournalType, f.journalType) : undefined,
    f.importBatchId ? eq(t.ImportBatchID, f.importBatchId) : undefined,
    f.periodFrom ? gte(periodOfDateColumn(t.PostingDate), f.periodFrom) : undefined,
    f.periodTo ? lte(periodOfDateColumn(t.PostingDate), f.periodTo) : undefined,
  ]);
  const { limit, offset } = paging(f);
  const idCol = id as unknown as (typeof rawPaypal.RawPaypalID);
  const rows = db.select().from(t).where(where).orderBy(asc(idCol)).limit(limit).offset(offset).all();
  const [{ total }] = db.select({ total: count() }).from(t).where(where).all();
  const byStatus = db.select({ k: t.BuildStatus, n: count() }).from(t).groupBy(t.BuildStatus).all();
  const journalTypes = db.selectDistinct({ v: t.JournalType }).from(t).orderBy(asc(t.JournalType)).all().map((r) => r.v);
  return { rows: rows as Record<string, unknown>[], total, byStatus, journalTypes: journalTypes.filter((v): v is string => !!v) };
}

export const listImportBatches = () => getDb().select().from(importBatch).orderBy(desc(importBatch.ImportBatchID)).all();
export const listBuildBatches = () => getDb().select().from(buildBatch).orderBy(desc(buildBatch.BuildBatchID)).all();
export const listPostingBatches = () => getDb().select().from(postingBatch).orderBy(desc(postingBatch.PostBatchID)).all();

export interface ExceptionFilter extends Paging {
  batchType?: string | null;
  exceptionType?: string | null;
  severity?: string | null;
  comCode?: string | null;
  search?: string | null;
}

export function listExceptions(f: ExceptionFilter) {
  const db = getDb();
  const where = whereOf([
    f.batchType ? eq(exceptionLog.BatchType, f.batchType) : undefined,
    f.exceptionType ? eq(exceptionLog.ExceptionType, f.exceptionType) : undefined,
    f.severity ? eq(exceptionLog.Severity, f.severity) : undefined,
    f.comCode ? eq(exceptionLog.ComCode, f.comCode) : undefined,
    likeAny(f.search, exceptionLog.SourceKey, exceptionLog.Message),
  ]);
  const { limit, offset } = paging(f);
  const rows = db.select().from(exceptionLog).where(where).orderBy(desc(exceptionLog.ID)).limit(limit).offset(offset).all();
  const [{ total }] = db.select({ total: count() }).from(exceptionLog).where(where).all();
  const byType = db
    .select({ BatchType: exceptionLog.BatchType, Severity: exceptionLog.Severity, ExceptionType: exceptionLog.ExceptionType, Count: count() })
    .from(exceptionLog)
    .groupBy(exceptionLog.BatchType, exceptionLog.Severity, exceptionLog.ExceptionType)
    .orderBy(asc(exceptionLog.BatchType), asc(exceptionLog.ExceptionType))
    .all();
  return { rows, total, byType };
}

// ───────────── Dashboard & options ─────────────

export function dashboardStats() {
  const db = getDb();
  const group = <T extends string>(rows: { k: T | null; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k ?? "", r.n]));
  const raw = group(db.select({ k: rawOrders.BuildStatus, n: count() }).from(rawOrders).groupBy(rawOrders.BuildStatus).all());
  // Số dòng raw của từng nguồn ngoài Orders + số event/GL theo DataSource
  const rawBySource = Object.fromEntries(
    (Object.keys(RAW_SOURCE_TABLES) as SourceKey[]).map((key) => {
      const t = RAW_SOURCE_TABLES[key].table as unknown as typeof rawPaypal;
      return [key, group(db.select({ k: t.BuildStatus, n: count() }).from(t).groupBy(t.BuildStatus).all())];
    }),
  );
  const eventsBySource = group(
    db.select({ k: accountingEvent.DataSource, n: count() }).from(accountingEvent).groupBy(accountingEvent.DataSource).all(),
  );
  const glBySource = group(db.select({ k: glTrans.DataSource, n: count() }).from(glTrans).groupBy(glTrans.DataSource).all());
  const events = group(db.select({ k: accountingEvent.PostStatus, n: count() }).from(accountingEvent).groupBy(accountingEvent.PostStatus).all());
  const [gl] = db
    .select({
      lines: count(),
      docs: sql<number>`count(distinct ${glTrans.DocNum})`,
      dr: sql<number>`round(coalesce(sum(${glTrans.AccountedDr}), 0), 2)`,
      cr: sql<number>`round(coalesce(sum(${glTrans.AccountedCr}), 0), 2)`,
    })
    .from(glTrans)
    .all();
  const exceptions = group(db.select({ k: exceptionLog.Severity, n: count() }).from(exceptionLog).groupBy(exceptionLog.Severity).all());
  return {
    raw,
    rawBySource,
    eventsBySource,
    glBySource,
    rawTotal: Object.values(raw).reduce((a, b) => a + b, 0),
    events,
    eventsTotal: Object.values(events).reduce((a, b) => a + b, 0),
    gl,
    exceptions,
    imports: db.select().from(importBatch).orderBy(desc(importBatch.ImportBatchID)).limit(5).all(),
    builds: db.select().from(buildBatch).orderBy(desc(buildBatch.BuildBatchID)).limit(5).all(),
    posts: db.select().from(postingBatch).orderBy(desc(postingBatch.PostBatchID)).limit(5).all(),
  };
}

export function filterOptions() {
  const db = getDb();
  return {
    comCodes: db.select({ value: company.ComCode, label: company.CompanyName }).from(company).orderBy(asc(company.ComCode)).all(),
    journalTypeCodes: db
      .selectDistinct({ value: journalType.JournalTypeCode, dataSource: journalType.DataSource })
      .from(journalType)
      .orderBy(asc(journalType.DataSource), asc(journalType.JournalTypeCode))
      .all(),
    dataSources: [
      ...new Set([
        ORDERS_DATA_SOURCE,
        ...(Object.keys(RAW_SOURCE_TABLES) as SourceKey[]).map((k) => SOURCE_META[k].dataSource),
        ...db.selectDistinct({ v: accountingEvent.DataSource }).from(accountingEvent).all().map((r) => r.v),
      ]),
    ].sort(),
    periods: [
      ...new Set([
        ...db.selectDistinct({ p: accountingEvent.Period }).from(accountingEvent).all().map((r) => r.p),
        ...db.selectDistinct({ p: periodOfDateColumn(rawOrders.FulfilledAt) }).from(rawOrders).all().map((r) => r.p),
        ...(Object.keys(RAW_SOURCE_TABLES) as SourceKey[]).flatMap((k) => {
          const t = RAW_SOURCE_TABLES[k].table as unknown as typeof rawPaypal;
          return db.selectDistinct({ p: periodOfDateColumn(t.PostingDate) }).from(t).all().map((r) => r.p);
        }),
      ]),
    ]
      .filter((p) => p && /^\d{6}$/.test(p))
      .sort(),
    postBatches: db.select({ value: postingBatch.PostBatchID, classify: postingBatch.Classify, status: postingBatch.Status }).from(postingBatch).orderBy(desc(postingBatch.PostBatchID)).all(),
  };
}

// ───────────── Master ─────────────

export const MASTER_TABLES = {
  gatewayCompanyMapping,
  company,
  partners,
  journalType,
  journalLineRule,
  coa,
  exrate,
  mappingBankAccount,
} as const;

export type MasterTableKey = keyof typeof MASTER_TABLES;

export function listMaster(key: MasterTableKey, f: Paging & { search?: string | null }) {
  const db = getDb();
  if (key === "partners") {
    const where = likeAny(f.search, partners.PartnerCode, partners.PartnerName, partners.PartnerTaxID, partners.PartnerType);
    const { limit, offset } = paging(f);
    const rows = db.select().from(partners).where(where).orderBy(asc(partners.PartnerID)).limit(limit).offset(offset).all();
    const [{ total }] = db.select({ total: count() }).from(partners).where(where).all();
    return { rows, total };
  }
  const rows = db.select().from(MASTER_TABLES[key]).all() as Record<string, unknown>[];
  const text = f.search?.trim().toLowerCase();
  const filtered = text ? rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(text))) : rows;
  return { rows: filtered, total: filtered.length };
}
