CREATE TABLE `canary_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_key` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`line` text NOT NULL,
	`trip_from` text,
	`trip_to` text,
	`ok` integer NOT NULL,
	`arrived` integer NOT NULL,
	`watched_min` real,
	`readings` integer DEFAULT 0 NOT NULL,
	`reversals` integer DEFAULT 0 NOT NULL,
	`catastrophic` integer DEFAULT 0 NOT NULL,
	`worst_drift_sec` real,
	`first_sight_miss_sec` integer,
	`failures_json` text DEFAULT '[]' NOT NULL,
	`jumps_json` text DEFAULT '[]' NOT NULL,
	`alerted_at` integer,
	`resolved_at` integer,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canary_runs_run_key_unique` ON `canary_runs` (`run_key`);--> statement-breakpoint
CREATE INDEX `canary_runs_time_idx` ON `canary_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `canary_runs_line_time_idx` ON `canary_runs` (`line`,`started_at`);