CREATE TABLE `model_params` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`published_at` integer NOT NULL,
	`accepted` integer NOT NULL,
	`version` text NOT NULL,
	`window_from` text NOT NULL,
	`window_to` text NOT NULL,
	`window_days` integer NOT NULL,
	`params` text NOT NULL,
	`n` text NOT NULL,
	`note` text,
	`decision` text
);
--> statement-breakpoint
CREATE INDEX `model_params_published_idx` ON `model_params` (`published_at`);