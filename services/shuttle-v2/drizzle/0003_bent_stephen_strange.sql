ALTER TABLE `daily_actives` ADD `first_seen_ms` integer;--> statement-breakpoint
ALTER TABLE `daily_actives` ADD `last_seen_ms` integer;--> statement-breakpoint
ALTER TABLE `daily_actives` ADD `polls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_actives` ADD `searches` integer DEFAULT 0 NOT NULL;