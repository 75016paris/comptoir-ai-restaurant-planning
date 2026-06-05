CREATE TABLE IF NOT EXISTS `whatsapp_context_sessions` (
  `phone` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `selected_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `expires_at` TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_whatsapp_context_sessions_expires_at`
  ON `whatsapp_context_sessions` (`expires_at`);
