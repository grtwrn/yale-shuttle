CREATE TABLE `search_terms` (
	`day` text NOT NULL,
	`q` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`zero` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `q`)
);
