CREATE TABLE `worker_share_authorizations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `owner_id` TEXT NOT NULL REFERENCES `owners`(`id`),
  `source_restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `target_restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `role` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `invited_by_user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `worker_consented_at` TEXT,
  `revoked_at` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX `idx_worker_share_authorizations_unique_active`
ON `worker_share_authorizations` (`target_restaurant_id`, `user_id`, `role`)
WHERE `status` IN ('pending', 'accepted');

CREATE INDEX `idx_worker_share_authorizations_owner_target`
ON `worker_share_authorizations` (`owner_id`, `target_restaurant_id`, `status`);

CREATE INDEX `idx_worker_share_authorizations_worker`
ON `worker_share_authorizations` (`user_id`, `status`);
