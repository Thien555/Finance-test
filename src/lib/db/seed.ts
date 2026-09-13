/**
 * Seed master data từ snapshot CSV (data/seed) hoặc từ nội dung CSV tải về Google Sheet.
 */
import fs from "node:fs";
import path from "node:path";
import { count } from "drizzle-orm";
import {
  parseBankMappings,
  parseCoA,
  parseExrates,
  parseJournalLineRules,
  parseJournalTypes,
  parsePartners,
} from "@/lib/master/parse-master";
import { DEFAULT_COMPANIES, DEFAULT_GATEWAY_MAPPINGS, MASTER_SHEETS, type MasterSheetKey } from "@/lib/master/sources";
import type { AppDb } from "./client";
import {
  coa,
  company,
  exrate,
  gatewayCompanyMapping,
  journalLineRule,
  journalType,
  mappingBankAccount,
  partners,
} from "./schema";

export type MasterCsvTexts = Record<MasterSheetKey, string>;

export const SEED_DIR = path.join(process.cwd(), "data", "seed");

export function readSnapshotTexts(): MasterCsvTexts {
  const read = (key: MasterSheetKey) => fs.readFileSync(path.join(SEED_DIR, MASTER_SHEETS[key].file), "utf8");
  return {
    partners: read("partners"),
    journalType: read("journalType"),
    journalLineRule: read("journalLineRule"),
    coa: read("coa"),
    exrate: read("exrate"),
    mappingBankAccount: read("mappingBankAccount"),
  };
}

function chunk<T>(rows: T[], size = 300): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Parse toàn bộ trước, lỗi thì không đụng DB */
export function parseMasterTexts(texts: MasterCsvTexts) {
  const parsed = {
    partners: parsePartners(texts.partners),
    journalType: parseJournalTypes(texts.journalType),
    journalLineRule: parseJournalLineRules(texts.journalLineRule),
    coa: parseCoA(texts.coa),
    exrate: parseExrates(texts.exrate),
    mappingBankAccount: parseBankMappings(texts.mappingBankAccount),
  };
  for (const [key, rows] of Object.entries(parsed)) {
    if (rows.length === 0) throw new Error(`Sheet ${key} không có dữ liệu hợp lệ`);
  }
  return parsed;
}

/** Thay toàn bộ 6 bảng master bằng dữ liệu mới (1 transaction) */
export function replaceMasters(db: AppDb, texts: MasterCsvTexts) {
  const parsed = parseMasterTexts(texts);
  db.transaction((tx) => {
    tx.delete(partners).run();
    tx.delete(journalType).run();
    tx.delete(journalLineRule).run();
    tx.delete(coa).run();
    tx.delete(exrate).run();
    tx.delete(mappingBankAccount).run();
    for (const c of chunk(parsed.partners)) tx.insert(partners).values(c).run();
    for (const c of chunk(parsed.journalType)) tx.insert(journalType).values(c).run();
    for (const c of chunk(parsed.journalLineRule)) tx.insert(journalLineRule).values(c).run();
    for (const c of chunk(parsed.coa)) tx.insert(coa).values(c).run();
    for (const c of chunk(parsed.exrate)) tx.insert(exrate).values(c).run();
    for (const c of chunk(parsed.mappingBankAccount)) tx.insert(mappingBankAccount).values(c).run();
  });
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.length])) as Record<MasterSheetKey, number>;
}

export function seedDefaults(db: AppDb) {
  const [{ n: companies }] = db.select({ n: count() }).from(company).all();
  if (companies === 0) db.insert(company).values(DEFAULT_COMPANIES).run();
  const [{ n: mappings }] = db.select({ n: count() }).from(gatewayCompanyMapping).all();
  if (mappings === 0) db.insert(gatewayCompanyMapping).values(DEFAULT_GATEWAY_MAPPINGS).run();
}

export function seedMastersIfEmpty(db: AppDb) {
  const [{ n }] = db.select({ n: count() }).from(journalType).all();
  if (n === 0) replaceMasters(db, readSnapshotTexts());
  seedDefaults(db);
}
