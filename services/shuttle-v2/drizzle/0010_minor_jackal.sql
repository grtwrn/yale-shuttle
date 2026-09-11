CREATE TABLE `legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`route_id` integer NOT NULL,
	`from_stop_id` integer NOT NULL,
	`from_index` integer NOT NULL,
	`to_stop_id` integer NOT NULL,
	`to_index` integer NOT NULL,
	`hops` integer NOT NULL,
	`departed_at` integer NOT NULL,
	`arrived_at` integer NOT NULL,
	`to_pinned_at` integer,
	`leg_sec` real NOT NULL,
	`hold_sec` real NOT NULL,
	`drive_sec` real NOT NULL,
	`holds` integer NOT NULL,
	`reached` integer NOT NULL,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `legs_route_hop_time_idx` ON `legs` (`route_id`,`from_stop_id`,`to_stop_id`,`departed_at`);--> statement-breakpoint
CREATE INDEX `legs_time_idx` ON `legs` (`departed_at`);--> statement-breakpoint
CREATE TABLE `stop_visits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bus_id` integer NOT NULL,
	`bus_name` text NOT NULL,
	`anchor_bus_id` integer NOT NULL,
	`route_id` integer NOT NULL,
	`stop_id` integer NOT NULL,
	`stop_index` integer NOT NULL,
	`anchored_at` integer NOT NULL,
	`pinned_at` integer,
	`arrived_at` integer,
	`departed_at` integer,
	`stand_sec` real,
	`inside_sec` real,
	`outcome` text NOT NULL,
	`how` text,
	`confidence` real,
	`first_step_m` real,
	`steps` integer NOT NULL,
	`far_m` real,
	`confirm_sec` real,
	`rest_polls` integer NOT NULL,
	`shuffles` integer NOT NULL,
	`first_moved_at` integer,
	`last_at_rest_at` integer,
	`closest_m` real NOT NULL,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stop_visits_route_stop_time_idx` ON `stop_visits` (`route_id`,`stop_id`,`anchored_at`);--> statement-breakpoint
CREATE INDEX `stop_visits_time_idx` ON `stop_visits` (`anchored_at`);