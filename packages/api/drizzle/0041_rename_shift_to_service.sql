-- Rename shift-related tables to service-related tables
ALTER TABLE `shifts` RENAME TO `services`;
ALTER TABLE `shift_templates` RENAME TO `service_templates`;
ALTER TABLE `shift_template_overrides` RENAME TO `service_template_overrides`;

-- Rename shift-related columns
ALTER TABLE `time_clocks` RENAME COLUMN `shift_id` TO `service_id`;
ALTER TABLE `swap_requests` RENAME COLUMN `requester_shift_id` TO `requester_service_id`;
ALTER TABLE `swap_requests` RENAME COLUMN `target_shift_id` TO `target_service_id`;

-- Rename role enum value 'server' → 'salle' in all role columns
UPDATE `users` SET `role` = 'salle' WHERE `role` = 'server';
UPDATE `services` SET `role` = 'salle' WHERE `role` = 'server';
UPDATE `service_templates` SET `role` = 'salle' WHERE `role` = 'server';
UPDATE `staffing_targets` SET `role` = 'salle' WHERE `role` = 'server';

-- Update audit_logs table_name references
UPDATE `audit_logs` SET `table_name` = 'services' WHERE `table_name` = 'shifts';

-- Rename remaining shift columns
ALTER TABLE `restaurants` RENAME COLUMN `require_chef_per_shift` TO `require_chef_per_service`;
