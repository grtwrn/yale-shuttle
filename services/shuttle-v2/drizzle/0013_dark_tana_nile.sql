DROP INDEX IF EXISTS `predictions_shown_uniq`;--> statement-breakpoint
ALTER TABLE `predictions_log` ADD `surface` text DEFAULT 'trip' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_shown_uniq` ON `predictions_log` (`bus_id`,`to_stop_id`,`predicted_at`,`surface`);