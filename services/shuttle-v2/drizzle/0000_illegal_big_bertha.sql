CREATE TABLE `arrivals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`route_id` integer NOT NULL,
	`stop_id` integer NOT NULL,
	`arrived_at` integer NOT NULL,
	`departed_at` integer,
	`dwell_sec` real,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `arrivals_route_stop_time_idx` ON `arrivals` (`route_id`,`stop_id`,`arrived_at`);--> statement-breakpoint
CREATE INDEX `arrivals_bus_time_idx` ON `arrivals` (`bus_id`,`arrived_at`);--> statement-breakpoint
CREATE TABLE `predictions_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`route_id` integer NOT NULL,
	`from_stop_id` integer NOT NULL,
	`to_stop_id` integer NOT NULL,
	`stops_ahead` integer NOT NULL,
	`predicted_sec` real NOT NULL,
	`predicted_low_sec` real NOT NULL,
	`predicted_high_sec` real NOT NULL,
	`predicted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `predictions_bus_to_time_idx` ON `predictions_log` (`bus_id`,`to_stop_id`,`predicted_at`);--> statement-breakpoint
CREATE TABLE `raw_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`route_id` integer NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`heading` real NOT NULL,
	`last_stop_id` integer,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `raw_positions_bus_time_idx` ON `raw_positions` (`bus_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`kind` text NOT NULL,
	`route_id` integer,
	`body` text NOT NULL,
	`context` text,
	`client_ip` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `routes` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`color` text NOT NULL,
	`stops_json` text NOT NULL,
	`path_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`route_id` integer NOT NULL,
	`from_stop_id` integer NOT NULL,
	`to_stop_id` integer NOT NULL,
	`travel_sec` real NOT NULL,
	`started_at` integer NOT NULL,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `segments_route_seg_time_idx` ON `segments` (`route_id`,`from_stop_id`,`to_stop_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `segments_route_seg_dow_hour_idx` ON `segments` (`route_id`,`from_stop_id`,`to_stop_id`,`dow`,`hour`);--> statement-breakpoint
CREATE TABLE `stops` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`updated_at` integer NOT NULL
);
