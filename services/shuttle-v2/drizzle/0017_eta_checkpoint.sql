CREATE TABLE `eta_checkpoint` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `value` blob NOT NULL
);
