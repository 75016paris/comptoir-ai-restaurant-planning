-- Additional email recipients for owner digests / alerts.
-- Owner's login email is NOT stored here; this is an extra dispatch list for
-- comptable / administrateur / co-owner addresses. Each row has a freeform
-- label and per-notification-type opt-ins.

CREATE TABLE IF NOT EXISTS `email_recipients` (
  `id` text PRIMARY KEY NOT NULL,
  `restaurant_id` text NOT NULL REFERENCES `restaurants`(`id`),
  `label` text NOT NULL,
  `email` text NOT NULL,
  `send_monthly_digest` integer NOT NULL DEFAULT 0,
  `send_leave_alerts` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS `email_recipients_restaurant_idx`
  ON `email_recipients` (`restaurant_id`);
