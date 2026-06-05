-- Prune + rename optimizer-weight presets (v2 taxonomy).
-- Drops "equite-max" + "ot-friendly" (redundant with Mode/Distribution controls).
-- Adds "economique" (promotes the unused budget-serre preset) + "resilience".
--
-- SQLite doesn't support ALTER TABLE DROP/MODIFY CHECK and Bun's sqlite driver
-- blocks PRAGMA writable_schema. So we rebuild the table following the project's
-- standard migration pattern (see 0042_fix_staffing_targets_role_constraint.sql).

PRAGMA foreign_keys = OFF;

-- 1. Remap legacy values BEFORE rebuild (current CHECK still accepts them).
UPDATE restaurants SET preferred_style = 'equilibre'
  WHERE preferred_style IN ('equite-max','ot-friendly');

-- 2. Rebuild the restaurants table with the new CHECK constraint.
--    Column list mirrors the exact shape post-migration 0071.
CREATE TABLE `restaurants_new` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `timezone` text DEFAULT 'Europe/Paris' NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `open_days` text DEFAULT '[2,3,4,5,6,7]' NOT NULL,
  `medical_mode` integer DEFAULT 0 NOT NULL,
  `swap_approval` INTEGER NOT NULL DEFAULT 0,
  `notify_on_swap` INTEGER NOT NULL DEFAULT 1,
  `tap_in_out_enabled` INTEGER NOT NULL DEFAULT 1,
  `reminder_frequency` TEXT NOT NULL DEFAULT 'off',
  `color_scheme` TEXT NOT NULL DEFAULT 'classic',
  `worker_preferences_enabled` INTEGER NOT NULL DEFAULT 0,
  `auto_staffing_weeks` integer NOT NULL DEFAULT 0,
  `disabled_compliance_rules` TEXT NOT NULL DEFAULT '[]',
  `overtime_mode` TEXT NOT NULL DEFAULT 'flexible',
  `overtime_weekly_cap` INTEGER NOT NULL DEFAULT 48,
  `overtime_distribution` TEXT NOT NULL DEFAULT 'willing-first',
  `stripe_customer_id` TEXT,
  `stripe_subscription_id` TEXT,
  `status` TEXT NOT NULL DEFAULT 'active',
  `subscription_status` TEXT NOT NULL DEFAULT 'active',
  `subscription_period_end` TEXT,
  `trial_ends_at` TEXT,
  `cancel_at` TEXT,
  `latitude` REAL,
  `longitude` REAL,
  `address` TEXT,
  `school_zone` TEXT,
  `holiday_zone` TEXT,
  `role_based_staffing` INTEGER NOT NULL DEFAULT 0,
  `kitchen_sub_roles` TEXT NOT NULL DEFAULT '["Chef","Sous-chef","Cuisinier","Plongeur"]',
  `salle_sub_roles` TEXT NOT NULL DEFAULT '["Chef de rang","Serveur","Runner","Barman"]',
  `kitchen_color` TEXT NOT NULL DEFAULT 'amber',
  `salle_color` TEXT NOT NULL DEFAULT 'sky',
  `hcr_grid` TEXT NOT NULL DEFAULT '{}',
  `subrole_hcr_map` TEXT NOT NULL DEFAULT '{}',
  `default_contract_type` TEXT NOT NULL DEFAULT 'CDI' CHECK (default_contract_type IN ('CDI','CDD','saisonnier')),
  `default_contract_hours` INTEGER NOT NULL DEFAULT 35,
  `preferred_style` TEXT NOT NULL DEFAULT 'equilibre'
    CHECK (preferred_style IN ('equilibre','equipe-stable','flexibilite','economique','resilience')),
  `custom_weights` TEXT
);

-- 3. Copy data column-by-column in the exact legacy order.
INSERT INTO restaurants_new (
  id, name, timezone, created_at, open_days, medical_mode, swap_approval,
  notify_on_swap, tap_in_out_enabled, reminder_frequency, color_scheme,
  worker_preferences_enabled, auto_staffing_weeks, disabled_compliance_rules,
  overtime_mode, overtime_weekly_cap, overtime_distribution, stripe_customer_id,
  stripe_subscription_id, status, subscription_status, subscription_period_end,
  trial_ends_at, cancel_at, latitude, longitude, address, school_zone, holiday_zone,
  role_based_staffing, kitchen_sub_roles, salle_sub_roles, kitchen_color, salle_color,
  hcr_grid, subrole_hcr_map, default_contract_type, default_contract_hours,
  preferred_style, custom_weights
)
SELECT
  id, name, timezone, created_at, open_days, medical_mode, swap_approval,
  notify_on_swap, tap_in_out_enabled, reminder_frequency, color_scheme,
  worker_preferences_enabled, auto_staffing_weeks, disabled_compliance_rules,
  overtime_mode, overtime_weekly_cap, overtime_distribution, stripe_customer_id,
  stripe_subscription_id, status, subscription_status, subscription_period_end,
  trial_ends_at, cancel_at, latitude, longitude, address, school_zone, holiday_zone,
  role_based_staffing, kitchen_sub_roles, salle_sub_roles, kitchen_color, salle_color,
  hcr_grid, subrole_hcr_map, default_contract_type, default_contract_hours,
  preferred_style, custom_weights
FROM restaurants;

-- 4. Swap in the new table.
DROP TABLE restaurants;
ALTER TABLE restaurants_new RENAME TO restaurants;

PRAGMA foreign_keys = ON;
PRAGMA wal_checkpoint(TRUNCATE);
