CREATE TABLE `daily_actives` (
	`day` text NOT NULL,
	`anon_id` text NOT NULL,
	PRIMARY KEY(`day`, `anon_id`)
);
--> statement-breakpoint
CREATE INDEX `daily_actives_day_idx` ON `daily_actives` (`day`);