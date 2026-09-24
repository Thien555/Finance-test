import { readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import type { AppDb } from "@/lib/db/client";
import {
  type AccountingEventRow,
  company,
  type CompanyRow,
  gatewayCompanyMapping,
  type RawOrderRow,
  type RawPaypalRow,
  type RawPipoRow,
  type RawStripeRow,
} from "@/lib/db/schema";
import type { EventDraft } from "@/lib/engine/types";
import { MasterIndex, type Masters } from "@/lib/engine/masters";
import { readTable } from "@/lib/io/read-table";
import {
  parseBankMappings,
  parseCoA,
  parseExrates,
  parseJournalLineRules,
  parseGatewayMappings,
  parseJournalTypes,
  parsePartners,
} from "@/lib/master/parse-master";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";
import { canonicalHeaderMap, SOURCE_META, type SourceKey } from "@/lib/sources/columns";
import {
  normalizePaypalRow,
  normalizePipoRow,
  normalizeStripeRow,
} from "@/lib/sources/normalize";

const root = path.resolve(import.meta.dirname, "..", "..");
const seed = (file: string) => readFileSync(path.join(root, "data", "seed", file), "utf8");

/**
 * Company & GatewayCompanyMapping cố định cho test, không lấy snapshot data/seed: 2 bảng đó sửa trên web
 * (ONTARIO thật dùng CAD), còn các test đổi cổng cần ONTARIO cùng USD với ZENIROXPAY.
 */
export const TEST_COMPANIES: CompanyRow[] = [
  { ComCode: "ZENIROXPAY", CompanyName: "ZeniroxPay Inc.", FunctionalCurrency: "USD", IsActive: 1 },
  { ComCode: "ONTARIO", CompanyName: "Ontario", FunctionalCurrency: "USD", IsActive: 1 },
];

/**
 * Lấy thẳng mọi cổng ZENIROXPAY từ snapshot seed thay vì liệt kê tay: file order thật dùng 13 tên cổng,
 * thiếu 1 tên là hàng nghìn dòng thành MISSING_COMCODE và mọi baseline sai.
 * 2 giá trị cố ý không có mapping ("Zenirox Pay SPF-BDU" và ô trống) là dòng lỗi kỳ vọng.
 * `ZeniroxPay - Stripe` là cổng các kịch bản remap đổi sang ONTARIO.
 */
export const TEST_GATEWAY_MAPPINGS = parseGatewayMappings(seed("gateway-company-mapping.csv")).filter((m) => m.ComCode === "ZENIROXPAY");

/** DB tạm của test integration: thay Company & GatewayCompanyMapping vừa seed từ snapshot bằng bộ cố định ở trên */
export function seedTestCompanies(db: AppDb) {
  db.transaction((tx) => {
    tx.delete(gatewayCompanyMapping).run();
    tx.delete(company).run();
    tx.insert(company).values(TEST_COMPANIES).run();
    tx.insert(gatewayCompanyMapping).values(TEST_GATEWAY_MAPPINGS).run();
  });
}

export function loadMasters(): Masters {
  return {
    partners: parsePartners(seed("partners.csv")),
    journalTypes: parseJournalTypes(seed("journal-type.csv")),
    lineRules: parseJournalLineRules(seed("journal-line-rule.csv")),
    coa: parseCoA(seed("coa.csv")),
    exrates: parseExrates(seed("exrate.csv")),
    bankMappings: parseBankMappings(seed("mapping-bank-account.csv")).map((m, i) => ({ ID: i + 1, ...m })),
    companies: TEST_COMPANIES,
    gatewayMappings: TEST_GATEWAY_MAPPINGS.map((g, i) => ({ ID: i + 1, ...g })),
  };
}

export function loadIndex(overrides: Partial<Masters> = {}) {
  return new MasterIndex({ ...loadMasters(), ...overrides });
}

/** Parse file mẫu tốn vài giây (55k–142k dòng) và nhiều file test cùng gọi → cache theo tên file trong 1 process */
const cache = new Map<string, Promise<unknown>>();
const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key) ?? load();
  cache.set(key, hit);
  return hit as Promise<T>;
};

export function loadSampleOrders(file = "order-data.csv"): Promise<RawOrderRow[]> {
  return memo(`orders:${file}`, async () => {
    const buffer = readFileSync(path.join(root, "data", "samples", file));
    const table = await readTable(buffer, file, "OrderId");
    const { map } = canonicalHeaders(table.headers);
    const rows: RawOrderRow[] = [];
    table.records.forEach((record, i) => {
      const r = normalizeOrderRow(record, map);
      // File thật có vài dòng rác (thiếu OrderId/ItemCode) — import cũng loại ra, không phải lỗi test
      if (r.ok) rows.push({ ...r.row, RawOrderID: i + 1, ImportBatchID: 1, ComCode: null, BuildStatus: "NOT_BUILT", BuildMessage: null } as RawOrderRow);
    });
    return rows;
  });
}

/** Đọc file mẫu của 1 nguồn ngoài Orders qua đúng normalizer thật */
function loadSourceSample<T>(
  file: string,
  source: SourceKey,
  normalize: (record: Record<string, unknown>, map: Map<string, string>) => { ok: true; row: T } | { ok: false; error: string },
): Promise<T[]> {
  return memo(`${source}:${file}`, async () => {
    const buffer = readFileSync(path.join(root, "data", "samples", file));
    const table = await readTable(buffer, file);
    const meta = SOURCE_META[source];
    const { map, missing } = canonicalHeaderMap(table.headers, meta.columns, meta.required);
    if (missing.length) throw new Error(`${file} thiếu cột: ${missing.join(", ")}`);
    return table.records.map((record, i) => {
      const r = normalize(record, map);
      if (!r.ok) throw new Error(`Row ${i + 2}: ${r.error}`);
      return r.row;
    });
  });
}

export async function loadSamplePaypal(file = "Bank_Paypal.csv"): Promise<RawPaypalRow[]> {
  const rows = await loadSourceSample(file, "paypal", (record, map) => normalizePaypalRow(record, map, SOURCE_META.paypal.columns));
  return rows.map((row, i) => ({ ...row, RawPaypalID: i + 1, ImportBatchID: 1 }) as RawPaypalRow);
}

export async function loadSampleStripe(file = "Bank_Stripe.csv"): Promise<RawStripeRow[]> {
  const rows = await loadSourceSample(file, "stripe", (record, map) => normalizeStripeRow(record, map, SOURCE_META.stripe.columns));
  return rows.map((row, i) => ({ ...row, RawStripeID: i + 1, ImportBatchID: 1 }) as RawStripeRow);
}

export async function loadSamplePipo(file = "Bank_Pipo.csv"): Promise<RawPipoRow[]> {
  const rows = await loadSourceSample(file, "pipo", (record, map) => normalizePipoRow(record, map, SOURCE_META.pipo.columns));
  return rows.map((row, i) => ({ ...row, RawPipoID: i + 1, ImportBatchID: 1 }) as RawPipoRow);
}

/** Bảng thô của file order (giữ nguyên chuỗi) — test integration dựng lại CSV từ đây */
export function loadOrderRecords(file = "order-data.csv"): Promise<{ headers: string[]; records: Record<string, string>[] }> {
  return memo(`orderRecords:${file}`, async () => {
    const buffer = readFileSync(path.join(root, "data", "samples", file));
    const table = await readTable(buffer, file, "OrderId");
    return { headers: table.headers, records: table.records as Record<string, string>[] };
  });
}

/**
 * Tập con tất định cắt từ chính file đầy đủ cho các test kịch bản (đổi cổng, chặn ghi trùng, reconcile):
 * 3 ngày giao hàng + các dòng chưa fulfill trả tiền trong tháng 11/2025.
 *
 * Chọn tập này vì nó **thuần kỳ 202511** (giữ nguyên được mọi `periodFrom/To = "202511"` của test cũ),
 * chứa cả 2 cổng cần cho kịch bản remap, và chứa 2 đơn mốc `MTUBV-181125-51MRR` / `QVAJV-191125-Q1Z3V`.
 * 431 dòng thay vì 55.111 → mỗi vòng import+build+post ~1s thay vì ~2 phút.
 */
export const SCENARIO_DAYS = ["2025-11-20", "2025-11-21", "2025-11-22"];
export const SCENARIO_PERIOD = "202511";
/** Ngày trống trong cùng kỳ — dùng khi kịch bản cần dời ngày giao mà không đụng dòng có sẵn */
export const SCENARIO_FREE_DAY = "2025-11-30";

const inScenario = (itemStatus: string, fulfilledAt: string, paidDateAt: string) =>
  itemStatus.trim().toUpperCase() === "FULFILLED"
    ? SCENARIO_DAYS.includes(fulfilledAt.slice(0, 10))
    : paidDateAt.slice(0, 7) === "2025-11";

export const scenarioRows = (rows: RawOrderRow[]): RawOrderRow[] =>
  rows.filter((r) => inScenario(r.ItemStatus ?? "", r.FulfilledAt ?? "", r.PaidDateAt ?? ""));

export const scenarioRecords = (records: Record<string, string>[]): Record<string, string>[] =>
  records.filter((r) => inScenario(r.ItemStatus ?? "", r.FulfilledAt ?? "", r.PaidDateAt ?? ""));

/** Dựng lại CSV đúng thứ tự cột gốc */
export const toCsv = (headers: string[], records: Record<string, string>[]): Buffer =>
  Buffer.from(Papa.unparse(records, { columns: headers }), "utf8");

/** CSV chỉ gồm header + 1 dòng đã sửa — thay cho việc import lại cả file để mô phỏng "sửa 1 dòng" */
export function oneRowCsv(
  headers: string[],
  records: Record<string, string>[],
  find: (r: Record<string, string>) => boolean,
  patch: Record<string, string>,
): Buffer {
  const row = records.find(find);
  if (!row) throw new Error("Không tìm thấy dòng cần sửa trong file mẫu");
  return toCsv(headers, [{ ...row, ...patch }]);
}

/** Giả lập insert DB: gán AccountingEventID tăng dần */
export function toEventRows(drafts: EventDraft[], startId = 1000): AccountingEventRow[] {
  return drafts.map(({ rawRowIds: _ignored, ...d }, i) => ({
    AccountingEventID: startId + i,
    LineSeq: 1,
    PairCode: null,
    AmountSource: null,
    OrderID: null,
    RefNum: null,
    SourceID: null,
    BankAccountNumber: null,
    BankGLAccount: null,
    ContraAccount: null,
    TransAccount: null,
    FeeAccount: null,
    PartnerCode: null,
    PartnerTaxID: null,
    PartnerName: null,
    Description: null,
    BalanceImpact: null,
    PostedDocNum: null,
    PostingGroupKey: null,
    PostBatchID: null,
    PostedAt: null,
    ErrorStage: null,
    ErrorMessage: null,
    ItemCodes: null,
    BuildBatchID: 1,
    AddDate: "2026-01-01 00:00:00",
    ModifiedDate: null,
    ...d,
  }));
}
