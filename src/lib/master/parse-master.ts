/**
 * Parse CSV export của các sheet master → row để insert DB.
 * Xử lý: chuỗi "NULL", số dấu phẩy thập phân, header cột ContraAccount bị ghi nhầm "11202052".
 */
import Papa from "papaparse";
import type {
  CoARow,
  ExrateRow,
  JournalLineRuleRow,
  JournalTypeRow,
  MappingBankAccountRow,
  PartnerRow,
} from "@/lib/db/schema";
import { parseDate, parseNumber, toFlag, toText } from "@/lib/engine/parse";

type Row = string[];

function parseCsv(text: string): { header: string[]; rows: Row[] } {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  const [header = [], ...rows] = parsed.data;
  return { header: header.map((h) => h.trim()), rows };
}

/** Lấy giá trị theo tên cột (không phân biệt hoa thường), fallback theo vị trí */
function getter(header: string[]) {
  const idx = new Map(header.map((h, i) => [h.toLowerCase(), i]));
  return (row: Row, name: string, fallbackPos?: number): string | undefined => {
    const i = idx.get(name.toLowerCase()) ?? fallbackPos;
    return i === undefined ? undefined : row[i];
  };
}

const requireInt = (v: unknown, fallback: number) => {
  const n = parseNumber(v);
  return n === null ? fallback : Math.trunc(n);
};

export function parsePartners(text: string): PartnerRow[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows.map((r, i) => ({
    PartnerID: requireInt(g(r, "PartnerID"), i + 1),
    PartnerType: toText(g(r, "PartnerType")),
    PartnerTaxID: toText(g(r, "PartnerTaxID")),
    PartnerCode: toText(g(r, "PartnerCode")),
    PartnerName: toText(g(r, "PartnerName")),
    BankAccount: toText(g(r, "BankAccount")),
    BankType: toText(g(r, "BankType")),
    RelatedParties: toText(g(r, "RelatedParties")),
    IsActive: toFlag(g(r, "IsActive"), 1),
  }));
}

export function parseJournalTypes(text: string): JournalTypeRow[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows
    .map((r, i) => ({
      JournalTypeID: requireInt(g(r, "JournalTypeID", 0), i + 1),
      DataSource: toText(g(r, "DataSource", 1)) ?? "",
      JournalType: toText(g(r, "JournalType", 2)),
      JournalTypeCode: toText(g(r, "JournalTypeCode", 3)) ?? "",
      BankAccount: toText(g(r, "BankAccount", 4)),
      // Header sheet đang ghi nhầm "11202052" → lấy theo vị trí cột 6
      ContraAccount: toText(g(r, "ContraAccount", 5)),
      TransAccount: toText(g(r, "TransAccount", 6)),
      FeeAccount: toText(g(r, "FeeAccount", 7)),
      Partner: toText(g(r, "Partner", 8)),
      Classify: toText(g(r, "Classify", 9)),
      GroupRule: toText(g(r, "GroupRule", 10)),
    }))
    .filter((r) => r.JournalTypeCode && r.DataSource);
}

export function parseJournalLineRules(text: string): JournalLineRuleRow[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows
    .map((r, i) => ({
      JournalLineRuleID: requireInt(g(r, "JournalLineRuleID"), i + 1),
      JournalTypeCode: toText(g(r, "JournalTypeCode")) ?? "",
      RuleSeq: requireInt(g(r, "RuleSeq"), 10),
      PairCode: toText(g(r, "PairCode")),
      NormalDrAccountSource: toText(g(r, "NormalDrAccountSource")),
      NormalCrAccountSource: toText(g(r, "NormalCrAccountSource")),
      AmountSource: toText(g(r, "AmountSource")),
      AmountFactor: parseNumber(g(r, "AmountFactor")) ?? 1,
      ReverseIfNegative: toFlag(g(r, "ReverseIfNegative"), 0),
      SkipIfDrAccountNull: toFlag(g(r, "SkipIfDrAccountNull"), 0),
      SkipIfCrAccountNull: toFlag(g(r, "SkipIfCrAccountNull"), 0),
      SkipIfAmountZero: toFlag(g(r, "SkipIfAmountZero"), 0),
      PartnerMode: toText(g(r, "PartnerMode")),
      FixedPartner: toText(g(r, "FixedPartner")),
      ApplyPartnerToDrLine: toFlag(g(r, "ApplyPartnerToDrLine"), 1),
      ApplyPartnerToCrLine: toFlag(g(r, "ApplyPartnerToCrLine"), 1),
      MemoTemplate: toText(g(r, "MemoTemplate")),
      IsActive: toFlag(g(r, "IsActive"), 1),
      NegativeMode: toText(g(r, "NegativeMode")),
    }))
    .filter((r) => r.JournalTypeCode);
}

export function parseCoA(text: string): CoARow[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows
    .map((r, i) => ({
      CoAID: requireInt(g(r, "CoAID"), i + 1),
      AccountCode: toText(g(r, "AccountCode")) ?? "",
      AccountName: toText(g(r, "AccountName")),
      AccountType: toText(g(r, "AccountType")),
      BalanceSide: toText(g(r, "BalanceSide")),
      Status: toText(g(r, "Status")),
      ARAP: toText(g(r, "ARAP")),
      ARAPType: toText(g(r, "ARAPType")),
    }))
    .filter((r) => r.AccountCode);
}

export function parseExrates(text: string): ExrateRow[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows
    .map((r, i) => ({
      ExrateID: requireInt(g(r, "ExrateID"), i + 1),
      Period: toText(g(r, "Period")) ?? "",
      ExrateDate: parseDate(g(r, "ExrateDate")),
      ReportCurrency: toText(g(r, "ReportCurrency")) ?? "",
      TransCurrency: toText(g(r, "TransCurrency")) ?? "",
      RateType: toText(g(r, "RateType")) ?? "MUL",
      Exrate: parseNumber(g(r, "Exrate")) ?? 0,
      SourceNote: toText(g(r, "SourceNote")),
      IsActive: toFlag(g(r, "IsActive"), 1),
    }))
    .filter((r) => r.Period && r.ReportCurrency && r.TransCurrency);
}

export function parseBankMappings(text: string): Omit<MappingBankAccountRow, "ID">[] {
  const { header, rows } = parseCsv(text);
  const g = getter(header);
  return rows
    .map((r) => ({
      ComCode: toText(g(r, "ComCode")) ?? "",
      BankAccountNumber: toText(g(r, "BankAccountNumber")) ?? "",
      InputCurr: toText(g(r, "InputCurr")),
      GLAccountCode: toText(g(r, "GLAccountCode")),
      BankName: toText(g(r, "BankName")),
      IsActive: toFlag(g(r, "IsActive"), 1),
    }))
    .filter((r) => r.ComCode && r.BankAccountNumber);
}
