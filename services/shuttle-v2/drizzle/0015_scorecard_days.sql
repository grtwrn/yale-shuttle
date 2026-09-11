CREATE TABLE `scorecard_days` (
	`day` text NOT NULL,
	`route_id` integer NOT NULL,
	`horizon` text NOT NULL,
	`surface` text NOT NULL,
	`metrics` text NOT NULL,
	`estimator_version` text,
	`scored_through` integer NOT NULL,
	`scored_at` integer NOT NULL,
	`final` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `route_id`, `horizon`, `surface`)
);
--> statement-breakpoint
CREATE INDEX `scorecard_days_day_idx` ON `scorecard_days` (`day`);