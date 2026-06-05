CREATE TABLE `owners` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `stripe_customer_id` TEXT,
  `stripe_subscription_id` TEXT,
  `subscription_status` TEXT NOT NULL DEFAULT 'active',
  `subscription_period_end` TEXT,
  `trial_ends_at` TEXT,
  `cancel_at` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE `restaurants` ADD COLUMN `owner_id` TEXT REFERENCES `owners`(`id`);

CREATE TABLE `owner_memberships` (
  `owner_id` TEXT NOT NULL REFERENCES `owners`(`id`),
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `role` TEXT NOT NULL,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`owner_id`, `user_id`)
);

CREATE TABLE `restaurant_memberships` (
  `restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `role` TEXT NOT NULL,
  `permissions` TEXT,
  `active` INTEGER NOT NULL DEFAULT 1,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`restaurant_id`, `user_id`)
);

CREATE TABLE `worker_restaurant_profiles` (
  `restaurant_id` TEXT NOT NULL REFERENCES `restaurants`(`id`),
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`),
  `priority` INTEGER NOT NULL DEFAULT 1,
  `sub_roles` TEXT NOT NULL DEFAULT '[]',
  `contract_type` TEXT,
  `contract_hours` INTEGER,
  `contract_end_date` TEXT,
  `max_weekly_hours` INTEGER,
  `admin_ot_override` INTEGER,
  `hcr_level` TEXT,
  `hourly_rate` INTEGER,
  `matricule` TEXT,
  `manager_notes` TEXT,
  `multi_restaurant_willing` INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (`restaurant_id`, `user_id`)
);

INSERT INTO `owners` (
  `id`,
  `name`,
  `stripe_customer_id`,
  `stripe_subscription_id`,
  `subscription_status`,
  `subscription_period_end`,
  `trial_ends_at`,
  `cancel_at`
)
SELECT
  'owner_' || `id`,
  `name`,
  `stripe_customer_id`,
  `stripe_subscription_id`,
  `subscription_status`,
  `subscription_period_end`,
  `trial_ends_at`,
  `cancel_at`
FROM `restaurants`;

UPDATE `restaurants`
SET `owner_id` = 'owner_' || `id`
WHERE `owner_id` IS NULL;

INSERT INTO `owner_memberships` (`owner_id`, `user_id`, `role`)
SELECT DISTINCT
  `restaurants`.`owner_id`,
  `users`.`id`,
  CASE
    WHEN `users`.`role` = 'admin' THEN 'owner_admin'
    WHEN `users`.`role` = 'manager' THEN 'owner_manager'
    ELSE 'member'
  END
FROM `users`
INNER JOIN `restaurants` ON `restaurants`.`id` = `users`.`restaurant_id`
WHERE `restaurants`.`owner_id` IS NOT NULL;

INSERT INTO `restaurant_memberships` (`restaurant_id`, `user_id`, `role`, `permissions`, `active`)
SELECT `restaurant_id`, `id`, `role`, `permissions`, `active`
FROM `users`;

INSERT INTO `worker_restaurant_profiles` (
  `restaurant_id`,
  `user_id`,
  `priority`,
  `sub_roles`,
  `contract_type`,
  `contract_hours`,
  `contract_end_date`,
  `max_weekly_hours`,
  `admin_ot_override`,
  `hcr_level`,
  `hourly_rate`,
  `matricule`,
  `manager_notes`,
  `multi_restaurant_willing`
)
SELECT
  `restaurant_id`,
  `id`,
  `priority`,
  `sub_roles`,
  `contract_type`,
  `contract_hours`,
  `contract_end_date`,
  `max_weekly_hours`,
  `admin_ot_override`,
  `hcr_level`,
  `hourly_rate`,
  `matricule`,
  `manager_notes`,
  `multi_restaurant_willing`
FROM `users`
WHERE `role` IN ('kitchen', 'floor');

CREATE INDEX `idx_restaurants_owner_id` ON `restaurants` (`owner_id`);
CREATE INDEX `idx_owner_memberships_user` ON `owner_memberships` (`user_id`);
CREATE INDEX `idx_restaurant_memberships_user` ON `restaurant_memberships` (`user_id`, `active`);
