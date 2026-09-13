CREATE TABLE `AccountingEvent` (
	`AccountingEventID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ComCode` text NOT NULL,
	`DataSource` text NOT NULL,
	`JournalTypeCode` text NOT NULL,
	`TransactionID` text NOT NULL,
	`EventSeq` integer NOT NULL,
	`LineSeq` integer DEFAULT 1 NOT NULL,
	`PairCode` text,
	`AmountSource` text,
	`PostingDate` text NOT NULL,
	`Period` text NOT NULL,
	`OrderID` text,
	`RefNum` text,
	`SourceID` text,
	`InputCurr` text NOT NULL,
	`FncCurr` text NOT NULL,
	`Amount` real NOT NULL,
	`BankAccountNumber` text,
	`BankGLAccount` text,
	`ContraAccount` text,
	`TransAccount` text,
	`FeeAccount` text,
	`PartnerCode` text,
	`PartnerTaxID` text,
	`PartnerName` text,
	`Description` text,
	`BalanceImpact` text,
	`PostStatus` text NOT NULL,
	`PostedDocNum` text,
	`PostingGroupKey` text,
	`PostBatchID` integer,
	`PostedAt` text,
	`ErrorStage` text,
	`ErrorMessage` text,
	`SourceHash` text NOT NULL,
	`BuildBatchID` integer,
	`AddDate` text NOT NULL,
	`ModifiedDate` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `UX_AccountingEvent_Key` ON `AccountingEvent` (`ComCode`,`DataSource`,`JournalTypeCode`,`TransactionID`,`EventSeq`);--> statement-breakpoint
CREATE INDEX `IX_AccountingEvent_Status` ON `AccountingEvent` (`PostStatus`);--> statement-breakpoint
CREATE INDEX `IX_AccountingEvent_DocNum` ON `AccountingEvent` (`PostedDocNum`);--> statement-breakpoint
CREATE INDEX `IX_AccountingEvent_Source` ON `AccountingEvent` (`DataSource`,`SourceID`);--> statement-breakpoint
CREATE TABLE `BuildBatch` (
	`BuildBatchID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`DataSource` text NOT NULL,
	`ComCodeList` text,
	`PeriodFrom` text,
	`PeriodTo` text,
	`StartedAt` text NOT NULL,
	`EndedAt` text,
	`Status` text NOT NULL,
	`SourceRows` integer DEFAULT 0 NOT NULL,
	`EventsCreated` integer DEFAULT 0 NOT NULL,
	`EventsReplaced` integer DEFAULT 0 NOT NULL,
	`EventsError` integer DEFAULT 0 NOT NULL,
	`SkippedRows` integer DEFAULT 0 NOT NULL,
	`ErrorMessage` text
);
--> statement-breakpoint
CREATE TABLE `CoA` (
	`CoAID` integer PRIMARY KEY NOT NULL,
	`AccountCode` text NOT NULL,
	`AccountName` text,
	`AccountType` text,
	`BalanceSide` text,
	`Status` text,
	`ARAP` text,
	`ARAPType` text
);
--> statement-breakpoint
CREATE TABLE `Company` (
	`ComCode` text PRIMARY KEY NOT NULL,
	`CompanyName` text,
	`FunctionalCurrency` text DEFAULT 'USD' NOT NULL,
	`IsActive` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ExceptionLog` (
	`ID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`BatchType` text NOT NULL,
	`BatchID` integer,
	`DataSource` text,
	`ComCode` text,
	`Period` text,
	`Severity` text NOT NULL,
	`ExceptionType` text NOT NULL,
	`SourceKey` text,
	`Message` text,
	`CreatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_ExceptionLog_Type` ON `ExceptionLog` (`BatchType`,`ExceptionType`);--> statement-breakpoint
CREATE TABLE `Exrate` (
	`ExrateID` integer PRIMARY KEY NOT NULL,
	`Period` text NOT NULL,
	`ExrateDate` text,
	`ReportCurrency` text NOT NULL,
	`TransCurrency` text NOT NULL,
	`RateType` text NOT NULL,
	`Exrate` real NOT NULL,
	`SourceNote` text,
	`IsActive` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `GatewayCompanyMapping` (
	`ID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`PaymentGatewayName` text NOT NULL,
	`ComCode` text NOT NULL,
	`IsActive` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GatewayCompanyMapping_PaymentGatewayName_unique` ON `GatewayCompanyMapping` (`PaymentGatewayName`);--> statement-breakpoint
CREATE TABLE `GLTrans` (
	`ID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ComCode` text NOT NULL,
	`DataSource` text NOT NULL,
	`JournalTypeCode` text NOT NULL,
	`DocNum` text NOT NULL,
	`PostingGroupKey` text,
	`PostBatchID` integer NOT NULL,
	`ReferenceTxnID` text,
	`OrderID` text,
	`RefNum` text,
	`TransDate` text NOT NULL,
	`DocDate` text NOT NULL,
	`Period` text NOT NULL,
	`AccountCode` text NOT NULL,
	`BankAccountNumber` text,
	`PartnerCode` text,
	`PartnerTaxID` text,
	`InputCurr` text NOT NULL,
	`FncCurr` text NOT NULL,
	`InputDr` real DEFAULT 0 NOT NULL,
	`InputCr` real DEFAULT 0 NOT NULL,
	`XRate` real DEFAULT 1 NOT NULL,
	`RateType` text DEFAULT 'MUL' NOT NULL,
	`AccountedDr` real DEFAULT 0 NOT NULL,
	`AccountedCr` real DEFAULT 0 NOT NULL,
	`Description` text,
	`BalanceImpact` text NOT NULL,
	`IsReversal` integer,
	`ReverseID` integer,
	`IsReval` integer,
	`Segment` text,
	`AddDate` text NOT NULL,
	`ModifiedDate` text
);
--> statement-breakpoint
CREATE INDEX `IX_GLTrans_DocNum` ON `GLTrans` (`DocNum`);--> statement-breakpoint
CREATE INDEX `IX_GLTrans_Batch` ON `GLTrans` (`PostBatchID`);--> statement-breakpoint
CREATE INDEX `IX_GLTrans_Period` ON `GLTrans` (`ComCode`,`Period`);--> statement-breakpoint
CREATE TABLE `ImportBatch` (
	`ImportBatchID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`DataSource` text NOT NULL,
	`FileName` text,
	`UploadedAt` text NOT NULL,
	`Status` text NOT NULL,
	`TotalRows` integer DEFAULT 0 NOT NULL,
	`SuccessRows` integer DEFAULT 0 NOT NULL,
	`ErrorRows` integer DEFAULT 0 NOT NULL,
	`SkippedRows` integer DEFAULT 0 NOT NULL,
	`ErrorMessage` text,
	`ErrorDetails` text
);
--> statement-breakpoint
CREATE TABLE `JournalLineRule` (
	`JournalLineRuleID` integer PRIMARY KEY NOT NULL,
	`JournalTypeCode` text NOT NULL,
	`RuleSeq` integer NOT NULL,
	`PairCode` text,
	`NormalDrAccountSource` text,
	`NormalCrAccountSource` text,
	`AmountSource` text,
	`AmountFactor` real DEFAULT 1 NOT NULL,
	`ReverseIfNegative` integer DEFAULT 0 NOT NULL,
	`SkipIfDrAccountNull` integer DEFAULT 0 NOT NULL,
	`SkipIfCrAccountNull` integer DEFAULT 0 NOT NULL,
	`SkipIfAmountZero` integer DEFAULT 0 NOT NULL,
	`PartnerMode` text,
	`FixedPartner` text,
	`ApplyPartnerToDrLine` integer DEFAULT 1 NOT NULL,
	`ApplyPartnerToCrLine` integer DEFAULT 1 NOT NULL,
	`MemoTemplate` text,
	`IsActive` integer DEFAULT 1 NOT NULL,
	`NegativeMode` text
);
--> statement-breakpoint
CREATE TABLE `JournalType` (
	`JournalTypeID` integer PRIMARY KEY NOT NULL,
	`DataSource` text NOT NULL,
	`JournalType` text,
	`JournalTypeCode` text NOT NULL,
	`BankAccount` text,
	`ContraAccount` text,
	`TransAccount` text,
	`FeeAccount` text,
	`Partner` text,
	`Classify` text,
	`GroupRule` text
);
--> statement-breakpoint
CREATE TABLE `MappingBankAccount` (
	`ID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ComCode` text NOT NULL,
	`BankAccountNumber` text NOT NULL,
	`InputCurr` text,
	`GLAccountCode` text,
	`BankName` text,
	`IsActive` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `Partners` (
	`PartnerID` integer PRIMARY KEY NOT NULL,
	`PartnerType` text,
	`PartnerTaxID` text,
	`PartnerCode` text,
	`PartnerName` text,
	`BankAccount` text,
	`BankType` text,
	`RelatedParties` text,
	`IsActive` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_Partners_Code` ON `Partners` (`PartnerCode`);--> statement-breakpoint
CREATE INDEX `IX_Partners_TaxID` ON `Partners` (`PartnerTaxID`);--> statement-breakpoint
CREATE TABLE `PostingBatch` (
	`PostBatchID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`DataSource` text,
	`Classify` text NOT NULL,
	`JournalTypeCode` text,
	`ComCodeList` text,
	`PeriodFrom` text,
	`PeriodTo` text,
	`StartedAt` text NOT NULL,
	`EndedAt` text,
	`Status` text NOT NULL,
	`InsertedRows` integer DEFAULT 0 NOT NULL,
	`PostedEvents` integer DEFAULT 0 NOT NULL,
	`ErrorEvents` integer DEFAULT 0 NOT NULL,
	`SkippedEvents` integer DEFAULT 0 NOT NULL,
	`ErrorMessage` text,
	`AddDate` text NOT NULL,
	`ModifiedDate` text
);
--> statement-breakpoint
CREATE TABLE `RawOrders` (
	`RawOrderID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ImportBatchID` integer NOT NULL,
	`ComCode` text,
	`BuildStatus` text DEFAULT 'NOT_BUILT' NOT NULL,
	`BuildMessage` text,
	`RowHash` text NOT NULL,
	`OrderId` text NOT NULL,
	`ItemCode` text NOT NULL,
	`SKU` text,
	`ProductSKU` text,
	`VariantName` text,
	`Domain` text,
	`Quantity` real,
	`StoreName` text,
	`ItemStatus` text,
	`LastUpdatedAt` text,
	`PaidAt` text,
	`LastUpdatedDateAt` text,
	`PaidDateAt` text,
	`LastUpdatedTimeAt` text,
	`PaidTimeAt` text,
	`FulfilledAt` text,
	`TrackingNumber` text,
	`Carrier` text,
	`UnitPrice` real,
	`ShippingFee` real,
	`TotalPrice` real,
	`BuyerName` text,
	`BuyerEmail` text,
	`BuyerAddress1` text,
	`BuyerAddress2` text,
	`BuyerPhone` text,
	`BuyerCity` text,
	`BuyerProvince` text,
	`BuyerCountry` text,
	`BuyerZip` text,
	`BuyerCountryCode` text,
	`BuyerProvinceCode` text,
	`SellerEmail` text,
	`TransactionId` text,
	`Profit` real,
	`TaxID` text,
	`PlatformProductSKU` text,
	`Group` text,
	`GroupQuantity` real,
	`SupplierCost` real,
	`PaymentGatewayId` text,
	`PaymentGatewayName` text,
	`GatewayType` text,
	`FulfillmentCost` real,
	`AdditionalCost` real,
	`TaxFee` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RawOrders_ItemCode_unique` ON `RawOrders` (`ItemCode`);--> statement-breakpoint
CREATE INDEX `IX_RawOrders_Order` ON `RawOrders` (`OrderId`);--> statement-breakpoint
CREATE INDEX `IX_RawOrders_Fulfilled` ON `RawOrders` (`FulfilledAt`);