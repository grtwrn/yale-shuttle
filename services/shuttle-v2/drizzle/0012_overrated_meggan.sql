ALTER TABLE `predictions_log` ADD `client_build` text;--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_shown_uniq` ON `predictions_log` (`bus_id`,`to_stop_id`,`predicted_at`);