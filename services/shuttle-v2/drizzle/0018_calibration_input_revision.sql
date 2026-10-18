CREATE TABLE `calibration_input_revision` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `epoch` text NOT NULL,
  `revision` integer NOT NULL DEFAULT 0,
  `arrivals` integer NOT NULL DEFAULT 0,
  `segments` integer NOT NULL DEFAULT 0,
  `stop_visits` integer NOT NULL DEFAULT 0,
  `legs` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `calibration_input_revision` (`id`, `epoch`) VALUES (1, lower(hex(randomblob(16))));
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_arrivals_insert` AFTER INSERT ON `arrivals`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `arrivals` = `arrivals` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_arrivals_update` AFTER UPDATE ON `arrivals`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `arrivals` = `arrivals` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_arrivals_delete` AFTER DELETE ON `arrivals`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `arrivals` = `arrivals` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_segments_insert` AFTER INSERT ON `segments`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `segments` = `segments` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_segments_update` AFTER UPDATE ON `segments`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `segments` = `segments` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_segments_delete` AFTER DELETE ON `segments`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `segments` = `segments` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_stop_visits_insert` AFTER INSERT ON `stop_visits`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `stop_visits` = `stop_visits` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_stop_visits_update` AFTER UPDATE ON `stop_visits`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `stop_visits` = `stop_visits` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_stop_visits_delete` AFTER DELETE ON `stop_visits`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `stop_visits` = `stop_visits` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_legs_insert` AFTER INSERT ON `legs`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `legs` = `legs` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_legs_update` AFTER UPDATE ON `legs`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `legs` = `legs` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `calibration_revision_legs_delete` AFTER DELETE ON `legs`
BEGIN
  UPDATE `calibration_input_revision` SET `revision` = `revision` + 1, `legs` = `legs` + 1 WHERE `id` = 1;
END;
