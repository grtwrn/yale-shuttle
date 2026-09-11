CREATE TABLE `upstream_etas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sampled_at` integer NOT NULL,
	`calc_at` integer,
	`stop_id` integer NOT NULL,
	`route_id` integer,
	`bus_id` integer,
	`bus_name` text,
	`eta_min` integer,
	`eta_sec` integer,
	`probe` integer DEFAULT 0 NOT NULL,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `upstream_etas_stop_time_idx` ON `upstream_etas` (`stop_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `upstream_etas_bus_time_idx` ON `upstream_etas` (`bus_name`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `upstream_etas_time_idx` ON `upstream_etas` (`sampled_at`);