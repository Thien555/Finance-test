/**
 * Schema SQLite. Tên bảng/cột giữ đúng như các sheet mẫu để dễ đối chiếu.
 *
 * Nhóm bảng:
 *  - Master/config : Partners, JournalType, JournalLineRule, CoA, Exrate, MappingBankAccount, Company, GatewayCompanyMapping
 *  - Raw           : ImportBatch, RawOrders
 *  - Engine        : BuildBatch, AccountingEvent, PostingBatch, GLTrans, ExceptionLog
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ───────────────────────────── Master / config ─────────────────────────────

export const partners = sqliteTable(
  "Partners",
  {
    PartnerID: integer("PartnerID").primaryKey(),
    PartnerType: text("PartnerType"),
    PartnerTaxID: text("PartnerTaxID"),
    PartnerCode: text("PartnerCode"),
    PartnerName: text("PartnerName"),
    BankAccount: text("BankAccount"),
    BankType: text("BankType"),
    RelatedParties: text("RelatedParties"),
    IsActive: integer("IsActive").notNull().default(1),
  },
  (t) => [index("IX_Partners_Code").on(t.PartnerCode), index("IX_Partners_TaxID").on(t.PartnerTaxID)],
);

export const journalType = sqliteTable("JournalType", {
  JournalTypeID: integer("JournalTypeID").primaryKey(),
  DataSource: text("DataSource").notNull(),
  JournalType: text("JournalType"),
  JournalTypeCode: text("JournalTypeCode").notNull(),
  BankAccount: text("BankAccount"),
  ContraAccount: text("ContraAccount"),
  TransAccount: text("TransAccount"),
  FeeAccount: text("FeeAccount"),
  Partner: text("Partner"),
  Classify: text("Classify"),
  GroupRule: text("GroupRule"),
});

export const journalLineRule = sqliteTable("JournalLineRule", {
  JournalLineRuleID: integer("JournalLineRuleID").primaryKey(),
  JournalTypeCode: text("JournalTypeCode").notNull(),
  RuleSeq: integer("RuleSeq").notNull(),
  PairCode: text("PairCode"),
  NormalDrAccountSource: text("NormalDrAccountSource"),
  NormalCrAccountSource: text("NormalCrAccountSource"),
  AmountSource: text("AmountSource"),
  AmountFactor: real("AmountFactor").notNull().default(1),
  ReverseIfNegative: integer("ReverseIfNegative").notNull().default(0),
  SkipIfDrAccountNull: integer("SkipIfDrAccountNull").notNull().default(0),
  SkipIfCrAccountNull: integer("SkipIfCrAccountNull").notNull().default(0),
  SkipIfAmountZero: integer("SkipIfAmountZero").notNull().default(0),
  PartnerMode: text("PartnerMode"),
  FixedPartner: text("FixedPartner"),
  ApplyPartnerToDrLine: integer("ApplyPartnerToDrLine").notNull().default(1),
  ApplyPartnerToCrLine: integer("ApplyPartnerToCrLine").notNull().default(1),
  MemoTemplate: text("MemoTemplate"),
  IsActive: integer("IsActive").notNull().default(1),
  NegativeMode: text("NegativeMode"),
});

export const coa = sqliteTable("CoA", {
  CoAID: integer("CoAID").primaryKey(),
  AccountCode: text("AccountCode").notNull(),
  AccountName: text("AccountName"),
  AccountType: text("AccountType"),
  BalanceSide: text("BalanceSide"),
  Status: text("Status"),
  ARAP: text("ARAP"),
  ARAPType: text("ARAPType"),
});

export const exrate = sqliteTable("Exrate", {
  ExrateID: integer("ExrateID").primaryKey(),
  Period: text("Period").notNull(),
  ExrateDate: text("ExrateDate"),
  ReportCurrency: text("ReportCurrency").notNull(),
  TransCurrency: text("TransCurrency").notNull(),
  RateType: text("RateType").notNull(),
  Exrate: real("Exrate").notNull(),
  SourceNote: text("SourceNote"),
  IsActive: integer("IsActive").notNull().default(1),
});

export const mappingBankAccount = sqliteTable("MappingBankAccount", {
  ID: integer("ID").primaryKey({ autoIncrement: true }),
  ComCode: text("ComCode").notNull(),
  BankAccountNumber: text("BankAccountNumber").notNull(),
  InputCurr: text("InputCurr"),
  GLAccountCode: text("GLAccountCode"),
  BankName: text("BankName"),
  IsActive: integer("IsActive").notNull().default(1),
});

/** Công ty ghi sổ (= cổng thanh toán). FunctionalCurrency = FncCurr. */
export const company = sqliteTable("Company", {
  ComCode: text("ComCode").primaryKey(),
  CompanyName: text("CompanyName"),
  FunctionalCurrency: text("FunctionalCurrency").notNull().default("USD"),
  IsActive: integer("IsActive").notNull().default(1),
});

/** Map PaymentGatewayName (file order) → ComCode. */
export const gatewayCompanyMapping = sqliteTable("GatewayCompanyMapping", {
  ID: integer("ID").primaryKey({ autoIncrement: true }),
  PaymentGatewayName: text("PaymentGatewayName").notNull().unique(),
  ComCode: text("ComCode").notNull(),
  IsActive: integer("IsActive").notNull().default(1),
});

// ───────────────────────────── Raw source ─────────────────────────────

export const importBatch = sqliteTable("ImportBatch", {
  ImportBatchID: integer("ImportBatchID").primaryKey({ autoIncrement: true }),
  DataSource: text("DataSource").notNull(),
  FileName: text("FileName"),
  UploadedAt: text("UploadedAt").notNull(),
  Status: text("Status").notNull(), // SUCCESS | PARTIAL | FAILED
  TotalRows: integer("TotalRows").notNull().default(0),
  SuccessRows: integer("SuccessRows").notNull().default(0),
  ErrorRows: integer("ErrorRows").notNull().default(0),
  SkippedRows: integer("SkippedRows").notNull().default(0),
  ErrorMessage: text("ErrorMessage"),
  ErrorDetails: text("ErrorDetails"), // JSON [{row, key, message}]
});

export const rawOrders = sqliteTable(
  "RawOrders",
  {
    RawOrderID: integer("RawOrderID").primaryKey({ autoIncrement: true }),
    ImportBatchID: integer("ImportBatchID").notNull(),
    ComCode: text("ComCode"),
    BuildStatus: text("BuildStatus").notNull().default("NOT_BUILT"), // NOT_BUILT | BUILT | SKIPPED | ERROR
    BuildMessage: text("BuildMessage"),
    RowHash: text("RowHash").notNull(),
    // ── 46 cột của file order ──
    OrderId: text("OrderId").notNull(),
    ItemCode: text("ItemCode").notNull().unique(),
    SKU: text("SKU"),
    ProductSKU: text("ProductSKU"),
    VariantName: text("VariantName"),
    Domain: text("Domain"),
    Quantity: real("Quantity"),
    StoreName: text("StoreName"),
    ItemStatus: text("ItemStatus"),
    LastUpdatedAt: text("LastUpdatedAt"),
    PaidAt: text("PaidAt"),
    LastUpdatedDateAt: text("LastUpdatedDateAt"),
    PaidDateAt: text("PaidDateAt"),
    LastUpdatedTimeAt: text("LastUpdatedTimeAt"),
    PaidTimeAt: text("PaidTimeAt"),
    FulfilledAt: text("FulfilledAt"), // YYYY-MM-DD
    TrackingNumber: text("TrackingNumber"),
    Carrier: text("Carrier"),
    UnitPrice: real("UnitPrice"),
    ShippingFee: real("ShippingFee"),
    TotalPrice: real("TotalPrice"),
    BuyerName: text("BuyerName"),
    BuyerEmail: text("BuyerEmail"),
    BuyerAddress1: text("BuyerAddress1"),
    BuyerAddress2: text("BuyerAddress2"),
    BuyerPhone: text("BuyerPhone"),
    BuyerCity: text("BuyerCity"),
    BuyerProvince: text("BuyerProvince"),
    BuyerCountry: text("BuyerCountry"),
    BuyerZip: text("BuyerZip"),
    BuyerCountryCode: text("BuyerCountryCode"),
    BuyerProvinceCode: text("BuyerProvinceCode"),
    SellerEmail: text("SellerEmail"),
    TransactionId: text("TransactionId"),
    Profit: real("Profit"),
    TaxID: text("TaxID"),
    PlatformProductSKU: text("PlatformProductSKU"),
    Group: text("Group"),
    GroupQuantity: real("GroupQuantity"),
    SupplierCost: real("SupplierCost"),
    PaymentGatewayId: text("PaymentGatewayId"),
    PaymentGatewayName: text("PaymentGatewayName"),
    GatewayType: text("GatewayType"),
    FulfillmentCost: real("FulfillmentCost"),
    AdditionalCost: real("AdditionalCost"),
    TaxFee: real("TaxFee"),
  },
  (t) => [index("IX_RawOrders_Order").on(t.OrderId), index("IX_RawOrders_Fulfilled").on(t.FulfilledAt)],
);

/**
 * Cột chung của mọi bảng raw nguồn ngân hàng/PSP (PayPal, Stripe, PIPO, AccountingSource).
 *  - SourceKey  : khóa định danh dòng, duy nhất trong bảng (xem src/lib/<source>/normalize.ts)
 *  - PostingDate: ngày ghi sổ đã chuẩn hóa YYYY-MM-DD, dùng để lọc theo kỳ khi Build
 *  - ComCode    : lấy thẳng từ cột ComCode trên file (khác Orders — Orders suy ra từ PaymentGatewayName)
 * Các cột còn lại giữ **đúng tên header của sheet**, kể cả khoảng trắng và typo "BankAccoutNumber".
 */
const bankRawColumns = () => ({
  ImportBatchID: integer("ImportBatchID").notNull(),
  SourceKey: text("SourceKey").notNull().unique(),
  ComCode: text("ComCode"),
  PostingDate: text("PostingDate"),
  BuildStatus: text("BuildStatus").notNull().default("NOT_BUILT"), // NOT_BUILT | BUILT | SKIPPED | ERROR
  BuildMessage: text("BuildMessage"),
  RowHash: text("RowHash").notNull(),
});

export const rawPaypal = sqliteTable(
  "RawPaypal",
  {
    RawPaypalID: integer("RawPaypalID").primaryKey({ autoIncrement: true }),
    ...bankRawColumns(),
    // ── 23 cột sheet Bank_Paypal ──
    Date: text("Date"),
    Time: text("Time"),
    TimeZone: text("Time Zone"),
    Description: text("Description"),
    Currency: text("Currency"),
    Gross: real("Gross"),
    Fee: real("Fee"),
    Net: real("Net"),
    Balance: real("Balance"),
    TransactionID: text("Transaction ID"),
    FromEmailAddress: text("From Email Address"),
    Name: text("Name"),
    BankName: text("Bank Name"),
    BankAccount: text("Bank account"),
    PostageAndPackagingAmount: real("Postage and Packaging Amount"),
    VAT: real("VAT"),
    InvoiceID: text("Invoice ID"),
    ReferenceTxnID: text("Reference Txn ID"),
    JournalType: text("JournalType"),
    StoreName: text("StoreName"),
    PartnerCode: text("PartnerCode"),
    BankAccoutNumber: text("BankAccoutNumber"),
  },
  (t) => [index("IX_RawPaypal_Posting").on(t.PostingDate), index("IX_RawPaypal_Txn").on(t.TransactionID)],
);

export const rawStripe = sqliteTable(
  "RawStripe",
  {
    RawStripeID: integer("RawStripeID").primaryKey({ autoIncrement: true }),
    ...bankRawColumns(),
    // ── 30 cột sheet Bank_Stripe ──
    Date: text("Date"),
    Id: text("id"),
    Type: text("Type"),
    Source: text("Source"),
    Amount: real("Amount"),
    Fee: real("Fee"),
    Net: real("Net"),
    Currency: text("Currency"),
    CreatedUtc: text("Created (UTC)"),
    AvailableOnUtc: text("Available On (UTC)"),
    MetaReason: text("reason (metadata)"),
    MetaAmount: real("amount (metadata)"),
    MetaFromOurPlatform: text("fromOurPlatform (metadata)"),
    MetaNote: text("note (metadata)"),
    MetaInvoiceId: text("invoiceId (metadata)"),
    MetaStoreId: text("storeId (metadata)"),
    MetaDomain: text("domain (metadata)"),
    MetaDiscount: real("discount (metadata)"),
    MetaFreeShip: text("freeShip (metadata)"),
    MetaLink: text("link (metadata)"),
    MetaItem: text("item (metadata)"),
    MetaShippingFee: real("shippingFee (metadata)"),
    MetaSubTotal: real("subTotal (metadata)"),
    MetaTax: real("tax (metadata)"),
    MetaStoreName: text("storeName (metadata)"),
    JournalType: text("JournalType"),
    StoreName: text("StoreName"),
    PartnerCode: text("PartnerCode"),
    BankAccoutNumber: text("BankAccoutNumber"),
  },
  (t) => [index("IX_RawStripe_Posting").on(t.PostingDate), index("IX_RawStripe_Id").on(t.Id)],
);

export const rawPipo = sqliteTable(
  "RawPipo",
  {
    RawPipoID: integer("RawPipoID").primaryKey({ autoIncrement: true }),
    ...bankRawColumns(),
    // ── 17 cột sheet Bank_Pipo ──
    Time: text("Time"),
    Currency: text("Currency"),
    Amount: real("Amount"),
    TransactionId: text("TransactionId"),
    CardNo: text("CardNo"),
    Fee: real("Fee"),
    Rate: real("Rate"),
    Net: real("Net"),
    Type: text("Type"),
    FromTo: text("From/To"),
    Status: text("Status"),
    Note: text("Note"),
    JournalType: text("JournalType"),
    StoreName: text("StoreName"),
    PartnerCode: text("PartnerCode"),
    BankAccoutNumber: text("BankAccoutNumber"),
  },
  (t) => [index("IX_RawPipo_Posting").on(t.PostingDate), index("IX_RawPipo_Txn").on(t.TransactionId)],
);

/** Hợp của 2 sheet "Master Card" và "Bank_Royal" — cả hai đều dùng JournalType của DataSource = AccountingSource */
export const rawAccountingSource = sqliteTable(
  "RawAccountingSource",
  {
    RawAccountingSourceID: integer("RawAccountingSourceID").primaryKey({ autoIncrement: true }),
    ...bankRawColumns(),
    /** Tên sheet nguồn: "Master Card" | "Bank_Royal" */
    SheetName: text("SheetName").notNull(),
    BankAccountNumber: text("BankAccountNumber"),
    JournalType: text("JournalType"),
    PartnerCode: text("PartnerCode"),
    Date: text("Date"),
    IDTransaction: text("ID Transaction"),
    Amount: real("Amount"),
    Currency: text("Currency"),
    InputCurr: text("InputCurr"),
    Description: text("Description"),
    BalanceImpact: text("BalanceImpact"), // Debit | Credit (chiều tiền trên sao kê)
    RefNum: text("RefNum"),
    Segment: text("Segment"),
    IsPosted: text("IsPosted"),
    BankAccount: text("BankAccount"),
    ContraAccount: text("ContraAccount"),
    TransAccount: text("TransAccount"),
  },
  (t) => [index("IX_RawAccountingSource_Posting").on(t.PostingDate), index("IX_RawAccountingSource_Sheet").on(t.SheetName)],
);

// ───────────────────────────── Engine ─────────────────────────────

export const buildBatch = sqliteTable("BuildBatch", {
  BuildBatchID: integer("BuildBatchID").primaryKey({ autoIncrement: true }),
  DataSource: text("DataSource").notNull(),
  ComCodeList: text("ComCodeList"),
  PeriodFrom: text("PeriodFrom"),
  PeriodTo: text("PeriodTo"),
  StartedAt: text("StartedAt").notNull(),
  EndedAt: text("EndedAt"),
  Status: text("Status").notNull(), // RUNNING | SUCCESS | FAILED
  SourceRows: integer("SourceRows").notNull().default(0),
  EventsCreated: integer("EventsCreated").notNull().default(0),
  EventsReplaced: integer("EventsReplaced").notNull().default(0),
  EventsError: integer("EventsError").notNull().default(0),
  SkippedRows: integer("SkippedRows").notNull().default(0),
  ErrorMessage: text("ErrorMessage"),
});

export const accountingEvent = sqliteTable(
  "AccountingEvent",
  {
    AccountingEventID: integer("AccountingEventID").primaryKey({ autoIncrement: true }),
    ComCode: text("ComCode").notNull(),
    DataSource: text("DataSource").notNull(),
    JournalTypeCode: text("JournalTypeCode").notNull(),
    TransactionID: text("TransactionID").notNull(),
    EventSeq: integer("EventSeq").notNull(),
    LineSeq: integer("LineSeq").notNull().default(1),
    PairCode: text("PairCode"),
    AmountSource: text("AmountSource"),
    PostingDate: text("PostingDate").notNull(), // YYYY-MM-DD
    Period: text("Period").notNull(), // YYYYMM
    OrderID: text("OrderID"),
    RefNum: text("RefNum"),
    SourceID: text("SourceID"),
    InputCurr: text("InputCurr").notNull(),
    FncCurr: text("FncCurr").notNull(),
    Amount: real("Amount").notNull(),
    BankAccountNumber: text("BankAccountNumber"),
    BankGLAccount: text("BankGLAccount"),
    ContraAccount: text("ContraAccount"),
    TransAccount: text("TransAccount"),
    FeeAccount: text("FeeAccount"),
    PartnerCode: text("PartnerCode"),
    PartnerTaxID: text("PartnerTaxID"),
    PartnerName: text("PartnerName"),
    Description: text("Description"),
    BalanceImpact: text("BalanceImpact"),
    PostStatus: text("PostStatus").notNull(), // NEW | POSTED | ERROR | SKIPPED
    PostedDocNum: text("PostedDocNum"),
    PostingGroupKey: text("PostingGroupKey"),
    PostBatchID: integer("PostBatchID"),
    PostedAt: text("PostedAt"),
    ErrorStage: text("ErrorStage"), // BUILD | POST
    ErrorMessage: text("ErrorMessage"),
    SourceHash: text("SourceHash").notNull(),
    /** JSON mảng ItemCode (đã sort) của các dòng nguồn tạo nên event — dùng chống ghi sổ trùng khi khóa event đổi. NULL = event cũ trước khi có cột */
    ItemCodes: text("ItemCodes"),
    BuildBatchID: integer("BuildBatchID"),
    AddDate: text("AddDate").notNull(),
    ModifiedDate: text("ModifiedDate"),
  },
  (t) => [
    uniqueIndex("UX_AccountingEvent_Key").on(t.ComCode, t.DataSource, t.JournalTypeCode, t.TransactionID, t.EventSeq),
    index("IX_AccountingEvent_Status").on(t.PostStatus),
    index("IX_AccountingEvent_DocNum").on(t.PostedDocNum),
    index("IX_AccountingEvent_Source").on(t.DataSource, t.SourceID),
    index("IX_AccountingEvent_Order").on(t.DataSource, t.OrderID),
  ],
);

export const postingBatch = sqliteTable("PostingBatch", {
  PostBatchID: integer("PostBatchID").primaryKey({ autoIncrement: true }),
  DataSource: text("DataSource"),
  Classify: text("Classify").notNull(), // Single | Bulk
  JournalTypeCode: text("JournalTypeCode"),
  ComCodeList: text("ComCodeList"),
  PeriodFrom: text("PeriodFrom"),
  PeriodTo: text("PeriodTo"),
  StartedAt: text("StartedAt").notNull(),
  EndedAt: text("EndedAt"),
  Status: text("Status").notNull(), // RUNNING | SUCCESS | FAILED | UNPOSTED
  InsertedRows: integer("InsertedRows").notNull().default(0),
  PostedEvents: integer("PostedEvents").notNull().default(0),
  ErrorEvents: integer("ErrorEvents").notNull().default(0),
  SkippedEvents: integer("SkippedEvents").notNull().default(0),
  ErrorMessage: text("ErrorMessage"),
  AddDate: text("AddDate").notNull(),
  ModifiedDate: text("ModifiedDate"),
});

export const glTrans = sqliteTable(
  "GLTrans",
  {
    ID: integer("ID").primaryKey({ autoIncrement: true }),
    ComCode: text("ComCode").notNull(),
    DataSource: text("DataSource").notNull(),
    JournalTypeCode: text("JournalTypeCode").notNull(),
    DocNum: text("DocNum").notNull(),
    PostingGroupKey: text("PostingGroupKey"),
    PostBatchID: integer("PostBatchID").notNull(),
    ReferenceTxnID: text("ReferenceTxnID"),
    OrderID: text("OrderID"),
    RefNum: text("RefNum"),
    TransDate: text("TransDate").notNull(),
    DocDate: text("DocDate").notNull(),
    Period: text("Period").notNull(),
    AccountCode: text("AccountCode").notNull(),
    BankAccountNumber: text("BankAccountNumber"),
    PartnerCode: text("PartnerCode"),
    PartnerTaxID: text("PartnerTaxID"),
    InputCurr: text("InputCurr").notNull(),
    FncCurr: text("FncCurr").notNull(),
    InputDr: real("InputDr").notNull().default(0),
    InputCr: real("InputCr").notNull().default(0),
    XRate: real("XRate").notNull().default(1),
    RateType: text("RateType").notNull().default("MUL"),
    AccountedDr: real("AccountedDr").notNull().default(0),
    AccountedCr: real("AccountedCr").notNull().default(0),
    Description: text("Description"),
    BalanceImpact: text("BalanceImpact").notNull(), // Debit | Credit
    IsReversal: integer("IsReversal"),
    ReverseID: integer("ReverseID"),
    IsReval: integer("IsReval"),
    Segment: text("Segment"),
    AddDate: text("AddDate").notNull(),
    ModifiedDate: text("ModifiedDate"),
  },
  (t) => [
    index("IX_GLTrans_DocNum").on(t.DocNum),
    index("IX_GLTrans_Batch").on(t.PostBatchID),
    index("IX_GLTrans_Period").on(t.ComCode, t.Period),
  ],
);

export const exceptionLog = sqliteTable(
  "ExceptionLog",
  {
    ID: integer("ID").primaryKey({ autoIncrement: true }),
    BatchType: text("BatchType").notNull(), // IMPORT | BUILD | POST
    BatchID: integer("BatchID"),
    DataSource: text("DataSource"),
    ComCode: text("ComCode"),
    Period: text("Period"),
    Severity: text("Severity").notNull(), // INFO | WARNING | ERROR
    ExceptionType: text("ExceptionType").notNull(),
    SourceKey: text("SourceKey"),
    Message: text("Message"),
    CreatedAt: text("CreatedAt").notNull(),
  },
  (t) => [index("IX_ExceptionLog_Type").on(t.BatchType, t.ExceptionType)],
);

// ───────────────────────────── Types ─────────────────────────────

export type PartnerRow = typeof partners.$inferSelect;
export type JournalTypeRow = typeof journalType.$inferSelect;
export type JournalLineRuleRow = typeof journalLineRule.$inferSelect;
export type CoARow = typeof coa.$inferSelect;
export type ExrateRow = typeof exrate.$inferSelect;
export type MappingBankAccountRow = typeof mappingBankAccount.$inferSelect;
export type CompanyRow = typeof company.$inferSelect;
export type GatewayCompanyMappingRow = typeof gatewayCompanyMapping.$inferSelect;
export type ImportBatchRow = typeof importBatch.$inferSelect;
export type RawOrderRow = typeof rawOrders.$inferSelect;
export type RawOrderInsert = typeof rawOrders.$inferInsert;
export type RawPaypalRow = typeof rawPaypal.$inferSelect;
export type RawPaypalInsert = typeof rawPaypal.$inferInsert;
export type RawStripeRow = typeof rawStripe.$inferSelect;
export type RawStripeInsert = typeof rawStripe.$inferInsert;
export type RawPipoRow = typeof rawPipo.$inferSelect;
export type RawPipoInsert = typeof rawPipo.$inferInsert;
export type RawAccountingSourceRow = typeof rawAccountingSource.$inferSelect;
export type RawAccountingSourceInsert = typeof rawAccountingSource.$inferInsert;
export type BuildBatchRow = typeof buildBatch.$inferSelect;
export type AccountingEventRow = typeof accountingEvent.$inferSelect;
export type AccountingEventInsert = typeof accountingEvent.$inferInsert;
export type PostingBatchRow = typeof postingBatch.$inferSelect;
export type GLTransRow = typeof glTrans.$inferSelect;
export type GLTransInsert = typeof glTrans.$inferInsert;
export type ExceptionLogRow = typeof exceptionLog.$inferSelect;
export type ExceptionLogInsert = typeof exceptionLog.$inferInsert;
