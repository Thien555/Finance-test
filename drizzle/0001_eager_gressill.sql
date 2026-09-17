ALTER TABLE `AccountingEvent` ADD `ItemCodes` text;--> statement-breakpoint
CREATE INDEX `IX_AccountingEvent_Order` ON `AccountingEvent` (`DataSource`,`OrderID`);