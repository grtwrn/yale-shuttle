CREATE INDEX `arrivals_time_idx` ON `arrivals` (`arrived_at`);--> statement-breakpoint
CREATE INDEX `predictions_time_idx` ON `predictions_log` (`predicted_at`);--> statement-breakpoint
CREATE INDEX `raw_positions_time_idx` ON `raw_positions` (`collected_at`);--> statement-breakpoint
CREATE INDEX `segments_time_idx` ON `segments` (`started_at`);