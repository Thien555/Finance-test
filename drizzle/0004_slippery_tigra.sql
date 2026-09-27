CREATE TABLE `AccountingPeriod` (
	`ComCode` text NOT NULL,
	`Period` text NOT NULL,
	`Status` text DEFAULT 'OPEN' NOT NULL,
	`LockedBy` text,
	`LockedAt` text,
	`UnlockedBy` text,
	`UnlockedAt` text,
	`UnlockReason` text,
	`Note` text,
	`ModifiedDate` text NOT NULL,
	PRIMARY KEY(`ComCode`, `Period`)
);
--> statement-breakpoint
CREATE INDEX `IX_AccountingPeriod_Status` ON `AccountingPeriod` (`Status`);--> statement-breakpoint
CREATE TABLE `AccountingPeriodLog` (
	`ID` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ComCode` text NOT NULL,
	`Period` text NOT NULL,
	`Action` text NOT NULL,
	`FromStatus` text NOT NULL,
	`ToStatus` text NOT NULL,
	`ActorName` text NOT NULL,
	`Reason` text,
	`ChecksSnapshot` text,
	`CreatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `IX_AccountingPeriodLog_Period` ON `AccountingPeriodLog` (`ComCode`,`Period`);