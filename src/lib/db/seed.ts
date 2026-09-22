/**
 * Seed master data từ snapshot CSV (data/seed) hoặc từ nội dung CSV tải về Google Sheet.
 * Company & GatewayCompanyMapping (sửa trên web, không có trong sheet) có snapshot riêng, đọc/ghi 2 chiều với DB.
 */
import fs from "node:fs";
import path from "node:path";
import { asc, count } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import Papa from "papaparse";
import {
  parseBankMappings,
  parseCoA,
  parseCompanies,
  parseExrates,
  parseGatewayMappings,
  parseJournalLineRules,
  parseJournalTypes,
  parsePartners,
} from "@/lib/master/parse-master";
import { LOCAL_MASTER_FILES, MASTER_SHEETS, type MasterSheetKey } from "@/lib/master/sources";
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

const readSeed = (file: string) => fs.readFileSync(path.join(SEED_DIR, file), "utf8");

export function readSnapshotTexts(): MasterCsvTexts {
  const read = (key: MasterSheetKey) => readSeed(MASTER_SHEETS[key].file);
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

/** Snapshot Company & GatewayCompanyMapping (data/seed/company.csv, gateway-company-mapping.csv) */
export function readCompanySnapshot() {
  const companies = parseCompanies(readSeed(LOCAL_MASTER_FILES.company));
  const gatewayMappings = parseGatewayMappings(readSeed(LOCAL_MASTER_FILES.gatewayCompanyMapping));
  if (companies.length === 0) throw new Error(`${LOCAL_MASTER_FILES.company} không có dữ liệu hợp lệ`);
  if (gatewayMappings.length === 0) throw new Error(`${LOCAL_MASTER_FILES.gatewayCompanyMapping} không có dữ liệu hợp lệ`);
  return { companies, gatewayMappings };
}

/**
 * Nạp snapshot Company & GatewayCompanyMapping: thêm mới hoặc cập nhật theo ComCode / PaymentGatewayName,
 * không xóa dòng chỉ có trong DB (2 bảng này sửa trên web). `tables` chọn bảng cần nạp.
 */
export function upsertCompanySnapshot(db: AppDb, tables = { company: true, gatewayCompanyMapping: true }) {
  const { companies, gatewayMappings } = readCompanySnapshot();
  db.transaction((tx) => {
    if (tables.company) {
      for (const c of companies) tx.insert(company).values(c).onConflictDoUpdate({ target: company.ComCode, set: c }).run();
    }
    if (tables.gatewayCompanyMapping) {
      for (const m of gatewayMappings) {
        tx.insert(gatewayCompanyMapping).values(m).onConflictDoUpdate({ target: gatewayCompanyMapping.PaymentGatewayName, set: m }).run();
      }
    }
  });
  return {
    company: tables.company ? companies.length : 0,
    gatewayCompanyMapping: tables.gatewayCompanyMapping ? gatewayMappings.length : 0,
  };
}

/** Ghi Company & GatewayCompanyMapping trong DB ra snapshot (`npm run db:export-seed`); mapping giữ thứ tự ID */
export function writeCompanySnapshot(db: AppDb, dir = SEED_DIR) {
  const companies = db.select().from(company).orderBy(asc(company.ComCode)).all();
  const gatewayMappings = db.select().from(gatewayCompanyMapping).orderBy(asc(gatewayCompanyMapping.ID)).all();
  const write = <T extends object>(file: string, rows: T[], columns: (keyof T & string)[]) =>
    fs.writeFileSync(path.join(dir, file), `${Papa.unparse(rows, { columns, newline: "\n" })}\n`, "utf8");
  write(LOCAL_MASTER_FILES.company, companies, ["ComCode", "CompanyName", "FunctionalCurrency", "IsActive"]);
  write(LOCAL_MASTER_FILES.gatewayCompanyMapping, gatewayMappings, ["PaymentGatewayName", "ComCode", "IsActive"]);
  return { company: companies.length, gatewayCompanyMapping: gatewayMappings.length };
}

const isEmpty = (db: AppDb, table: SQLiteTable) => db.select({ n: count() }).from(table).get()?.n === 0;

export function seedMastersIfEmpty(db: AppDb) {
  if (isEmpty(db, journalType)) replaceMasters(db, readSnapshotTexts());
  const tables = { company: isEmpty(db, company), gatewayCompanyMapping: isEmpty(db, gatewayCompanyMapping) };
  if (tables.company || tables.gatewayCompanyMapping) upsertCompanySnapshot(db, tables);
}
