CREATE TABLE `operator_anon_ids` (
	`anon_id` text PRIMARY KEY NOT NULL,
	`note` text,
	`added_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
