CREATE TABLE `standing_forecast_patterns` (
  `id` text PRIMARY KEY NOT NULL,
  `route_id` integer NOT NULL,
  `stop_ids` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `standing_forecast_observations` (
  `visit_id` integer PRIMARY KEY NOT NULL REFERENCES `stop_visits`(`id`) ON DELETE CASCADE,
  `known_at` integer NOT NULL,
  `pattern_id` text,
  `identity_ambiguous` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `standing_forecast_models` (
  `id` integer PRIMARY KEY NOT NULL,
  `algorithm` text NOT NULL,
  `fitted_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `model` text NOT NULL,
  `diagnostics` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stop_visits_route_bus_time_idx` ON `stop_visits` (`route_id`, `bus_name`, `anchored_at`, `id`);
