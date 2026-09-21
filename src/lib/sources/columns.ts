/**
 * Danh sách cột của các sheet nguồn ngoài Orders (dùng được ở client — không import node:*).
 * Tên cột giữ **đúng header của sheet**, kể cả khoảng trắng và typo `BankAccoutNumber`.
 */
export type ColumnKind = "text" | "number" | "date" | "datetime" | "time";

export type SourceColumn = [name: string, kind: ColumnKind];

/** Mã nguồn dùng trên URL/API/AccountingEvent.DataSource */
export const SOURCE_KEYS = ["paypal", "stripe", "pipo", "accounting-source"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export const PAYPAL_COLUMNS: SourceColumn[] = [
  ["Date", "date"],
  ["Time", "time"],
  ["Time Zone", "text"],
  ["Description", "text"],
  ["Currency", "text"],
  ["Gross", "number"],
  ["Fee", "number"],
  ["Net", "number"],
  ["Balance", "number"],
  ["Transaction ID", "text"],
  ["From Email Address", "text"],
  ["Name", "text"],
  ["Bank Name", "text"],
  ["Bank account", "text"],
  ["Postage and Packaging Amount", "number"],
  ["VAT", "number"],
  ["Invoice ID", "text"],
  ["Reference Txn ID", "text"],
  ["JournalType", "text"],
  ["StoreName", "text"],
  ["PartnerCode", "text"],
  ["ComCode", "text"],
  ["BankAccoutNumber", "text"],
];
export const PAYPAL_REQUIRED = ["Date", "Transaction ID", "Currency", "Gross", "ComCode"];

export const STRIPE_COLUMNS: SourceColumn[] = [
  ["Date", "date"],
  ["id", "text"],
  ["Type", "text"],
  ["Source", "text"],
  ["Amount", "number"],
  ["Fee", "number"],
  ["Net", "number"],
  ["Currency", "text"],
  ["Created (UTC)", "datetime"],
  ["Available On (UTC)", "datetime"],
  ["reason (metadata)", "text"],
  ["amount (metadata)", "number"],
  ["fromOurPlatform (metadata)", "text"],
  ["note (metadata)", "text"],
  ["invoiceId (metadata)", "text"],
  ["storeId (metadata)", "text"],
  ["domain (metadata)", "text"],
  ["discount (metadata)", "number"],
  ["freeShip (metadata)", "text"],
  ["link (metadata)", "text"],
  ["item (metadata)", "text"],
  ["shippingFee (metadata)", "number"],
  ["subTotal (metadata)", "number"],
  ["tax (metadata)", "number"],
  ["storeName (metadata)", "text"],
  ["JournalType", "text"],
  ["StoreName", "text"],
  ["PartnerCode", "text"],
  ["ComCode", "text"],
  ["BankAccoutNumber", "text"],
];
export const STRIPE_REQUIRED = ["Date", "id", "Type", "Amount", "Currency", "ComCode"];

export const PIPO_COLUMNS: SourceColumn[] = [
  ["Time", "datetime"],
  ["Currency", "text"],
  ["Amount", "number"],
  ["TransactionId", "text"],
  ["CardNo", "text"],
  ["Fee", "number"],
  ["Rate", "number"],
  ["Net", "number"],
  ["Type", "text"],
  ["From/To", "text"],
  ["Status", "text"],
  ["Note", "text"],
  ["JournalType", "text"],
  ["StoreName", "text"],
  ["PartnerCode", "text"],
  ["ComCode", "text"],
  ["BankAccoutNumber", "text"],
];
export const PIPO_REQUIRED = ["Time", "Amount", "TransactionId", "Currency", "Status", "ComCode"];

export const MASTER_CARD_COLUMNS: SourceColumn[] = [
  ["Comcode", "text"],
  ["BankAccountNumber", "text"],
  ["JournalType", "text"],
  ["PartnerCode", "text"],
  ["Date", "date"],
  ["ID Transaction", "text"],
  ["Amount", "number"],
  ["Currency", "text"],
];
export const MASTER_CARD_REQUIRED = ["Comcode", "JournalType", "Date", "Amount"];

export const BANK_ROYAL_COLUMNS: SourceColumn[] = [
  ["Comcode", "text"],
  ["BankAccountNumber", "text"],
  ["JournalType", "text"],
  ["Date", "date"],
  ["PartnerCode", "text"],
  ["InputCurr", "text"],
  ["Amount", "number"],
  ["Description", "text"],
  ["BalanceImpact", "text"],
  ["RefNum", "text"],
  ["Segment", "text"],
  ["IsPosted", "text"],
  ["BankAccount", "text"],
  ["ContraAccount", "text"],
  ["TransAccount", "text"],
];
export const BANK_ROYAL_REQUIRED = ["Comcode", "JournalType", "Date", "Amount", "BalanceImpact"];

/** Header trong file so khớp theo dạng đã bỏ hoa thường + mọi khoảng trắng ("Time Zone" ≡ "timezone") */
const canon = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "");

export function canonicalHeaderMap(
  headers: string[],
  columns: SourceColumn[],
  required: string[],
): { map: Map<string, string>; missing: string[] } {
  const wanted = new Map(columns.map(([name]) => [canon(name), name]));
  const map = new Map<string, string>();
  for (const h of headers) {
    const canonical = wanted.get(canon(h));
    if (canonical && !map.has(h)) map.set(h, canonical);
  }
  const present = new Set(map.values());
  return { map, missing: required.filter((c) => !present.has(c)) };
}

/** Mô tả từng nguồn cho UI (trang raw, panel Build, menu) */
export interface SourceMeta {
  key: SourceKey;
  /** AccountingEvent.DataSource */
  dataSource: string;
  label: string;
  /** Sheet mặc định trong Data-khac-order.xlsx */
  sheets: string[];
  columns: SourceColumn[];
  required: string[];
  /** Cột hiển thị đầu bảng trên trang raw */
  primary: string[];
}

export const SOURCE_META: Record<SourceKey, SourceMeta> = {
  paypal: {
    key: "paypal",
    dataSource: "PAYPAL",
    label: "PayPal",
    sheets: ["Bank_Paypal"],
    columns: PAYPAL_COLUMNS,
    required: PAYPAL_REQUIRED,
    primary: ["Date", "Transaction ID", "Description", "JournalType", "Gross", "Fee", "PartnerCode", "StoreName"],
  },
  stripe: {
    key: "stripe",
    dataSource: "STRIPE",
    label: "Stripe",
    sheets: ["Bank_Stripe"],
    columns: STRIPE_COLUMNS,
    required: STRIPE_REQUIRED,
    primary: ["Date", "id", "Type", "JournalType", "Amount", "Fee", "PartnerCode", "StoreName"],
  },
  pipo: {
    key: "pipo",
    dataSource: "PIPO",
    label: "PIPO / PingPong",
    sheets: ["Bank_Pipo"],
    columns: PIPO_COLUMNS,
    required: PIPO_REQUIRED,
    primary: ["Time", "TransactionId", "Type", "Status", "JournalType", "Amount", "PartnerCode", "StoreName"],
  },
  "accounting-source": {
    key: "accounting-source",
    dataSource: "ACCOUNTINGSOURCE",
    label: "AccountingSource (Master Card + Bank Royal)",
    sheets: ["Master Card", "Bank_Royal"],
    // Hợp của 2 sheet; normalize chọn đúng bộ cột theo sheet đang import
    columns: [...BANK_ROYAL_COLUMNS, ["ID Transaction", "text"], ["Currency", "text"]],
    required: MASTER_CARD_REQUIRED,
    primary: ["SheetName", "Date", "JournalType", "PartnerCode", "Amount", "BalanceImpact", "ContraAccount", "TransAccount"],
  },
};

export const SHEET_COLUMNS: Record<string, { columns: SourceColumn[]; required: string[] }> = {
  Bank_Paypal: { columns: PAYPAL_COLUMNS, required: PAYPAL_REQUIRED },
  Bank_Stripe: { columns: STRIPE_COLUMNS, required: STRIPE_REQUIRED },
  Bank_Pipo: { columns: PIPO_COLUMNS, required: PIPO_REQUIRED },
  "Master Card": { columns: MASTER_CARD_COLUMNS, required: MASTER_CARD_REQUIRED },
  Bank_Royal: { columns: BANK_ROYAL_COLUMNS, required: BANK_ROYAL_REQUIRED },
};
