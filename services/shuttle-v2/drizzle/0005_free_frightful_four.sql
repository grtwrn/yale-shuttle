CREATE TABLE `derived_paths` (
	`route_id` integer PRIMARY KEY NOT NULL,
	`path_json` text NOT NULL,
	`point_count` integer NOT NULL,
	`stop_count` integer NOT NULL,
	`median_stop_m` real NOT NULL,
	`p90_stop_m` real NOT NULL,
	`max_stop_m` real NOT NULL,
	`length_m` real NOT NULL,
	`trace_failures` integer NOT NULL,
	`bus_id` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`derived_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `raw_positions_route_time_idx` ON `raw_positions` (`route_id`,`collected_at`);