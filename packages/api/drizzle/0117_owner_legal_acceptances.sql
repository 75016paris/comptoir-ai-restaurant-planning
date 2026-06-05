ALTER TABLE `legal_acceptances` ADD COLUMN `owner_id` TEXT REFERENCES `owners`(`id`);

UPDATE `legal_acceptances`
SET `owner_id` = (
  SELECT `restaurants`.`owner_id`
  FROM `restaurants`
  WHERE `restaurants`.`id` = `legal_acceptances`.`restaurant_id`
)
WHERE `owner_id` IS NULL;

CREATE INDEX `idx_legal_acceptances_owner_type` ON `legal_acceptances` (`owner_id`, `acceptance_type`);
CREATE UNIQUE INDEX `idx_legal_acceptances_owner_terms_version`
  ON `legal_acceptances` (
    `owner_id`,
    `acceptance_type`,
    `terms_version`,
    `dpa_version`,
    `privacy_version`,
    `subprocessors_version`
  )
  WHERE `owner_id` IS NOT NULL;
