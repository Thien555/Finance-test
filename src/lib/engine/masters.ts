/**
 * Gói dữ liệu cấu hình (master) mà engine cần + các hàm tra cứu.
 * Engine chỉ nhận object này, không đọc DB → test được bằng dữ liệu CSV.
 */
import type {
  CoARow,
  CompanyRow,
  ExrateRow,
  GatewayCompanyMappingRow,
  JournalLineRuleRow,
  JournalTypeRow,
  MappingBankAccountRow,
  PartnerRow,
} from "@/lib/db/schema";

export interface Masters {
  journalTypes: JournalTypeRow[];
  lineRules: JournalLineRuleRow[];
  partners: PartnerRow[];
  exrates: ExrateRow[];
  coa: CoARow[];
  companies: CompanyRow[];
  gatewayMappings: GatewayCompanyMappingRow[];
  bankMappings: MappingBankAccountRow[];
}

export type AccountSource = "BANK_ACCOUNT" | "CONTRA_ACCOUNT" | "TRANS_ACCOUNT" | "FEE_ACCOUNT";

export type PartnerRule = { mode: "FIXED"; code: string } | { mode: "FROM_SOURCE" } | { mode: "NONE" };

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export class MasterIndex {
  private jtByKey = new Map<string, JournalTypeRow>();
  private rulesByJtc = new Map<string, JournalLineRuleRow[]>();
  private partnersByCode = new Map<string, PartnerRow[]>();
  private partnersByTaxId = new Map<string, PartnerRow[]>();
  private companyByCode = new Map<string, CompanyRow>();
  private comCodeByGateway = new Map<string, string>();
  private accountCodes = new Set<string>();

  constructor(public readonly masters: Masters) {
    for (const jt of masters.journalTypes) {
      this.jtByKey.set(`${norm(jt.DataSource)}|${norm(jt.JournalTypeCode)}`, jt);
    }
    for (const r of masters.lineRules) {
      if (!r.IsActive) continue;
      const k = norm(r.JournalTypeCode);
      const list = this.rulesByJtc.get(k) ?? [];
      list.push(r);
      this.rulesByJtc.set(k, list);
    }
    for (const list of this.rulesByJtc.values()) list.sort((a, b) => a.RuleSeq - b.RuleSeq);

    for (const p of masters.partners) {
      if (!p.IsActive) continue;
      push(this.partnersByCode, norm(p.PartnerCode), p);
      if (p.PartnerTaxID) push(this.partnersByTaxId, norm(p.PartnerTaxID), p);
    }
    for (const c of masters.companies) if (c.IsActive) this.companyByCode.set(norm(c.ComCode), c);
    for (const g of masters.gatewayMappings) {
      if (g.IsActive) this.comCodeByGateway.set(norm(g.PaymentGatewayName), g.ComCode.trim().toUpperCase());
    }
    for (const a of masters.coa) this.accountCodes.add(a.AccountCode.trim());
  }

  journalType(dataSource: string, journalTypeCode: string): JournalTypeRow | undefined {
    return this.jtByKey.get(`${norm(dataSource)}|${norm(journalTypeCode)}`);
  }

  activeRules(journalTypeCode: string): JournalLineRuleRow[] {
    return this.rulesByJtc.get(norm(journalTypeCode)) ?? [];
  }

  rule(journalTypeCode: string, ruleSeq: number): JournalLineRuleRow | undefined {
    return this.activeRules(journalTypeCode).find((r) => r.RuleSeq === ruleSeq);
  }

  partnersByCodeOf(code: string | null | undefined): PartnerRow[] {
    return this.partnersByCode.get(norm(code)) ?? [];
  }

  partnersByTaxIdOf(taxId: string | null | undefined): PartnerRow[] {
    return this.partnersByTaxId.get(norm(taxId)) ?? [];
  }

  company(comCode: string): CompanyRow | undefined {
    return this.companyByCode.get(norm(comCode));
  }

  comCodeOfGateway(paymentGatewayName: string | null | undefined): string | undefined {
    return this.comCodeByGateway.get(norm(paymentGatewayName));
  }

  hasAccount(accountCode: string): boolean {
    return this.accountCodes.size === 0 || this.accountCodes.has(accountCode.trim());
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** JournalType.Partner: "Fixed = Individuals" | "From Source" */
export function parsePartnerRule(partner: string | null | undefined): PartnerRule {
  if (!partner) return { mode: "NONE" };
  const s = partner.trim();
  const fixed = /^fixed\s*=\s*(.+)$/i.exec(s);
  if (fixed) return { mode: "FIXED", code: fixed[1].trim().toUpperCase() };
  if (/^from\s*source$/i.test(s)) return { mode: "FROM_SOURCE" };
  return { mode: "NONE" };
}

/** Lấy account theo NormalDr/CrAccountSource từ các cột account của event */
export function accountFromSource(
  source: string | null | undefined,
  accounts: { BankGLAccount: string | null; ContraAccount: string | null; TransAccount: string | null; FeeAccount: string | null },
): string | null {
  switch (norm(source) as AccountSource) {
    case "BANK_ACCOUNT":
      return accounts.BankGLAccount;
    case "CONTRA_ACCOUNT":
      return accounts.ContraAccount;
    case "TRANS_ACCOUNT":
      return accounts.TransAccount;
    case "FEE_ACCOUNT":
      return accounts.FeeAccount;
    default:
      return null;
  }
}
