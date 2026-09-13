/** Nguồn Google Sheet của master data (dùng cho nút "Sync từ Google Sheet" và snapshot seed). */
export const MASTER_SPREADSHEET_ID = "1CEQn7o4tgli3InJtF5cU8ePoPY9VYmUK";

export const MASTER_SHEETS = {
  partners: { gid: "1322113275", file: "partners.csv", label: "Partners" },
  journalType: { gid: "334328394", file: "journal-type.csv", label: "JournalType" },
  journalLineRule: { gid: "914272083", file: "journal-line-rule.csv", label: "JournalLineRule" },
  coa: { gid: "780643702", file: "coa.csv", label: "CoA" },
  exrate: { gid: "1288319457", file: "exrate.csv", label: "Exrate" },
  mappingBankAccount: { gid: "2073779528", file: "mapping-bank-account.csv", label: "MappingBankAccount" },
} as const;

export type MasterSheetKey = keyof typeof MASTER_SHEETS;

export const sheetCsvUrl = (gid: string, spreadsheetId = MASTER_SPREADSHEET_ID) =>
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;

/** Company & GatewayCompanyMapping không có trong sheet → seed mặc định, sửa trên web */
export const DEFAULT_COMPANIES = [
  { ComCode: "ZENIROXPAY", CompanyName: "ZeniroxPay Inc.", FunctionalCurrency: "USD", IsActive: 1 },
  { ComCode: "ONTARIO", CompanyName: "Ontario", FunctionalCurrency: "USD", IsActive: 1 },
];

export const DEFAULT_GATEWAY_MAPPINGS = [
  { PaymentGatewayName: "ZeniroxPay Inc.", ComCode: "ZENIROXPAY", IsActive: 1 },
  { PaymentGatewayName: "ZeniroxPay - Stripe", ComCode: "ZENIROXPAY", IsActive: 1 },
];
