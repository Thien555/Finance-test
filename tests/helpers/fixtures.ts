import { readFileSync } from "node:fs";
import path from "node:path";
import type { AccountingEventRow, RawOrderRow } from "@/lib/db/schema";
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
import { DEFAULT_COMPANIES, DEFAULT_GATEWAY_MAPPINGS } from "@/lib/master/sources";
import { canonicalHeaders, normalizeOrderRow } from "@/lib/orders/normalize";

const root = path.resolve(import.meta.dirname, "..", "..");
const seed = (file: string) => readFileSync(path.join(root, "data", "seed", file), "utf8");

export function loadMasters(): Masters {
  return {
    partners: parsePartners(seed("partners.csv")),
    journalTypes: parseJournalTypes(seed("journal-type.csv")),
    lineRules: parseJournalLineRules(seed("journal-line-rule.csv")),
    coa: parseCoA(seed("coa.csv")),
    exrates: parseExrates(seed("exrate.csv")),
    bankMappings: parseBankMappings(seed("mapping-bank-account.csv")).map((m, i) => ({ ID: i + 1, ...m })),
    companies: DEFAULT_COMPANIES,
    gatewayMappings: DEFAULT_GATEWAY_MAPPINGS.map((g, i) => ({ ID: i + 1, ...g })),
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

/** Giả lập insert DB: gán AccountingEventID tăng dần */
export function toEventRows(drafts: EventDraft[], startId = 1000): AccountingEventRow[] {
  return drafts.map(({ rawOrderIds: _ignored, ...d }, i) => ({
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
    BuildBatchID: 1,
    AddDate: "2026-01-01 00:00:00",
    ModifiedDate: null,
    ...d,
  }));
}
