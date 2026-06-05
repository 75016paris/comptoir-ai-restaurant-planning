CREATE TABLE `audit_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `restaurant_id` text NOT NULL REFERENCES `restaurants`(`id`),
  `table_name` text NOT NULL,
  `row_id` text NOT NULL,
  `action` text NOT NULL,
  `actor_id` text REFERENCES `users`(`id`),
  `actor_name` text,
  `source` text NOT NULL,
  `changes` text,
  `summary` text,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX `idx_audit_logs_restaurant_created` ON `audit_logs` (`restaurant_id`, `created_at`);
CREATE INDEX `idx_audit_logs_table_row` ON `audit_logs` (`table_name`, `row_id`);
