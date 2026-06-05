CREATE TABLE IF NOT EXISTS `shift_template_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `template_id` text NOT NULL REFERENCES `shift_templates`(`id`) ON DELETE CASCADE,
  `day_of_week` integer NOT NULL,
  `start_time` text NOT NULL,
  `end_time` text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `shift_template_overrides_template_day` ON `shift_template_overrides` (`template_id`, `day_of_week`);
