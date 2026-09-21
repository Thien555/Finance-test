CREATE TABLE `RawAccountingSource` (
	`RawAccountingSourceID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ImportBatchID` integer NOT NULL,
	`SourceKey` text NOT NULL,
	`ComCode` text,
	`PostingDate` text,
	`BuildStatus` text DEFAULT 'NOT_BUILT' NOT NULL,
	`BuildMessage` text,
	`RowHash` text NOT NULL,
	`SheetName` text NOT NULL,
	`BankAccountNumber` text,
	`JournalType` text,
	`PartnerCode` text,
	`Date` text,
	`ID Transaction` text,
	`Amount` real,
	`Currency` text,
	`InputCurr` text,
	`Description` text,
	`BalanceImpact` text,
	`RefNum` text,
	`Segment` text,
	`IsPosted` text,
	`BankAccount` text,
	`ContraAccount` text,
	`TransAccount` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RawAccountingSource_SourceKey_unique` ON `RawAccountingSource` (`SourceKey`);--> statement-breakpoint
CREATE INDEX `IX_RawAccountingSource_Posting` ON `RawAccountingSource` (`PostingDate`);--> statement-breakpoint
CREATE INDEX `IX_RawAccountingSource_Sheet` ON `RawAccountingSource` (`SheetName`);--> statement-breakpoint
CREATE TABLE `RawPaypal` (
	`RawPaypalID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ImportBatchID` integer NOT NULL,
	`SourceKey` text NOT NULL,
	`ComCode` text,
	`PostingDate` text,
	`BuildStatus` text DEFAULT 'NOT_BUILT' NOT NULL,
	`BuildMessage` text,
	`RowHash` text NOT NULL,
	`Date` text,
	`Time` text,
	`Time Zone` text,
	`Description` text,
	`Currency` text,
	`Gross` real,
	`Fee` real,
	`Net` real,
	`Balance` real,
	`Transaction ID` text,
	`From Email Address` text,
	`Name` text,
	`Bank Name` text,
	`Bank account` text,
	`Postage and Packaging Amount` real,
	`VAT` real,
	`Invoice ID` text,
	`Reference Txn ID` text,
	`JournalType` text,
	`StoreName` text,
	`PartnerCode` text,
	`BankAccoutNumber` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RawPaypal_SourceKey_unique` ON `RawPaypal` (`SourceKey`);--> statement-breakpoint
CREATE INDEX `IX_RawPaypal_Posting` ON `RawPaypal` (`PostingDate`);--> statement-breakpoint
CREATE INDEX `IX_RawPaypal_Txn` ON `RawPaypal` (`Transaction ID`);--> statement-breakpoint
CREATE TABLE `RawPipo` (
	`RawPipoID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ImportBatchID` integer NOT NULL,
	`SourceKey` text NOT NULL,
	`ComCode` text,
	`PostingDate` text,
	`BuildStatus` text DEFAULT 'NOT_BUILT' NOT NULL,
	`BuildMessage` text,
	`RowHash` text NOT NULL,
	`Time` text,
	`Currency` text,
	`Amount` real,
	`TransactionId` text,
	`CardNo` text,
	`Fee` real,
	`Rate` real,
	`Net` real,
	`Type` text,
	`From/To` text,
	`Status` text,
	`Note` text,
	`JournalType` text,
	`StoreName` text,
	`PartnerCode` text,
	`BankAccoutNumber` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RawPipo_SourceKey_unique` ON `RawPipo` (`SourceKey`);--> statement-breakpoint
CREATE INDEX `IX_RawPipo_Posting` ON `RawPipo` (`PostingDate`);--> statement-breakpoint
CREATE INDEX `IX_RawPipo_Txn` ON `RawPipo` (`TransactionId`);--> statement-breakpoint
CREATE TABLE `RawStripe` (
	`RawStripeID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ImportBatchID` integer NOT NULL,
	`SourceKey` text NOT NULL,
	`ComCode` text,
	`PostingDate` text,
	`BuildStatus` text DEFAULT 'NOT_BUILT' NOT NULL,
	`BuildMessage` text,
	`RowHash` text NOT NULL,
	`Date` text,
	`id` text,
	`Type` text,
	`Source` text,
	`Amount` real,
	`Fee` real,
	`Net` real,
	`Currency` text,
	`Created (UTC)` text,
	`Available On (UTC)` text,
	`reason (metadata)` text,
	`amount (metadata)` real,
	`fromOurPlatform (metadata)` text,
	`note (metadata)` text,
	`invoiceId (metadata)` text,
	`storeId (metadata)` text,
	`domain (metadata)` text,
	`discount (metadata)` real,
	`freeShip (metadata)` text,
	`link (metadata)` text,
	`item (metadata)` text,
	`shippingFee (metadata)` real,
	`subTotal (metadata)` real,
	`tax (metadata)` real,
	`storeName (metadata)` text,
	`JournalType` text,
	`StoreName` text,
	`PartnerCode` text,
	`BankAccoutNumber` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `RawStripe_SourceKey_unique` ON `RawStripe` (`SourceKey`);--> statement-breakpoint
CREATE INDEX `IX_RawStripe_Posting` ON `RawStripe` (`PostingDate`);--> statement-breakpoint
CREATE INDEX `IX_RawStripe_Id` ON `RawStripe` (`id`);