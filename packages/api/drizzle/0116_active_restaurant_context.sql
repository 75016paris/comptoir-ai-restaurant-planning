ALTER TABLE `sessions` ADD COLUMN `active_restaurant_id` TEXT REFERENCES `restaurants`(`id`);

UPDATE `sessions`
SET `active_restaurant_id` = (
  SELECT `restaurant_id`
  FROM `users`
  WHERE `users`.`id` = `sessions`.`user_id`
)
WHERE `active_restaurant_id` IS NULL;

CREATE INDEX `idx_sessions_active_restaurant_id` ON `sessions` (`active_restaurant_id`);
