import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppDb } from "@/lib/db/client";
import {
  type AccountingEventRow,
  company,
  type CompanyRow,
  gatewayCompanyMapping,
  type RawAccountingSourceRow,
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
  parseJournalTypes,
  parsePartners,
} from "@/lib/master/parse-master";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";
import { canonicalHeaderMap, SHEET_COLUMNS } from "@/lib/sources/columns";
import {
  normalizeAccountingSourceRow,
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

export const TEST_GATEWAY_MAPPINGS = [
  { PaymentGatewayName: "ZeniroxPay Inc.", ComCode: "ZENIROXPAY", IsActive: 1 },
  { PaymentGatewayName: "ZeniroxPay - Stripe", ComCode: "ZENIROXPAY", IsActive: 1 },
];

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

export async function loadSampleOrders(file = "orders-sample.csv"): Promise<RawOrderRow[]> {
  const buffer = readFileSync(path.join(root, "data", "samples", file));
  const table = await readTable(buffer, file, "OrderId");
  const { map } = canonicalHeaders(table.headers);
  return table.records.map((record, i) => {
    const r = normalizeOrderRow(record, map);
    if (!r.ok) throw new Error(`Row ${i + 2}: ${r.error}`);
    return { ...r.row, RawOrderID: i + 1, ImportBatchID: 1, ComCode: null, BuildStatus: "NOT_BUILT", BuildMessage: null } as RawOrderRow;
  });
}

/** Đọc file mẫu của 1 sheet nguồn ngoài Orders qua đúng normalizer thật */
async function loadSourceSample<T>(
  file: string,
  sheet: string,
  normalize: (record: Record<string, unknown>, map: Map<string, string>) => { ok: true; row: T } | { ok: false; error: string },
): Promise<T[]> {
  const buffer = readFileSync(path.join(root, "data", "samples", file));
  const table = await readTable(buffer, file);
  const spec = SHEET_COLUMNS[sheet];
  const { map, missing } = canonicalHeaderMap(table.headers, spec.columns, spec.required);
  if (missing.length) throw new Error(`${file} thiếu cột: ${missing.join(", ")}`);
  return table.records.map((record, i) => {
    const r = normalize(record, map);
    if (!r.ok) throw new Error(`Row ${i + 2}: ${r.error}`);
    return r.row;
  });
}

export async function loadSamplePaypal(file = "paypal-sample.csv"): Promise<RawPaypalRow[]> {
  const rows = await loadSourceSample(file, "Bank_Paypal", (record, map) =>
    normalizePaypalRow(record, map, SHEET_COLUMNS.Bank_Paypal.columns),
  );
  return rows.map((row, i) => ({ ...row, RawPaypalID: i + 1, ImportBatchID: 1 }) as RawPaypalRow);
}

export async function loadSampleStripe(file = "stripe-sample.csv"): Promise<RawStripeRow[]> {
  const rows = await loadSourceSample(file, "Bank_Stripe", (record, map) =>
    normalizeStripeRow(record, map, SHEET_COLUMNS.Bank_Stripe.columns),
  );
  return rows.map((row, i) => ({ ...row, RawStripeID: i + 1, ImportBatchID: 1 }) as RawStripeRow);
}

export async function loadSamplePipo(file = "pipo-sample.csv"): Promise<RawPipoRow[]> {
  const rows = await loadSourceSample(file, "Bank_Pipo", (record, map) =>
    normalizePipoRow(record, map, SHEET_COLUMNS.Bank_Pipo.columns),
  );
  return rows.map((row, i) => ({ ...row, RawPipoID: i + 1, ImportBatchID: 1 }) as RawPipoRow);
}

export async function loadSampleAccountingSource(
  file: string,
  sheet: "Master Card" | "Bank_Royal",
  startId = 1,
): Promise<RawAccountingSourceRow[]> {
  const seen = new Map<string, number>();
  const rows = await loadSourceSample(file, sheet, (record, map) =>
    normalizeAccountingSourceRow(record, map, SHEET_COLUMNS[sheet].columns, sheet, seen),
  );
  return rows.map((row, i) => ({ ...row, RawAccountingSourceID: startId + i, ImportBatchID: 1 }) as RawAccountingSourceRow);
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
