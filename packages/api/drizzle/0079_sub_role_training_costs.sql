-- Learned sub-role training costs per restaurant. Replaces the hardcoded
-- KITCHEN_HIERARCHY / SALLE_HIERARCHY fallbacks in optimize-engine.ts once a
-- (restaurant, from_role, to_role) pair has accumulated enough observations.
-- Feeds auto-optimize Phase 1 move scoring.
--
-- successes + failures < 5  → lookup returns the hardcoded default
-- owner_override = 1         → nightly observation skips this row
-- cost_points is clamped to [0.5×, 2×] of the hardcoded default on every
-- observation update (runaway guard).

CREATE TABLE `sub_role_training_costs` (
  `restaurant_id` text NOT NULL,
  `from_role` text NOT NULL,
  `to_role` text NOT NULL,
  `cost_points` real NOT NULL,
  `successes` integer NOT NULL DEFAULT 0,
  `failures` integer NOT NULL DEFAULT 0,
  `last_updated` integer NOT NULL,
  `owner_override` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`restaurant_id`, `from_role`, `to_role`)
);

-- Applied training moves awaiting outcome observation. Populated when the
-- frontend records that an owner accepted a cross_train / intra_train
-- suggestion. The nightly cron scans rows with NULL observed_at and
-- applied_at within the last 30 days, classifies the outcome, and updates
-- sub_role_training_costs.

CREATE TABLE `sub_role_training_moves` (
  `id` text PRIMARY KEY NOT NULL,
  `restaurant_id` text NOT NULL,
  `worker_id` text NOT NULL,
  `move_type` text NOT NULL,
  `from_role` text NOT NULL,
  `to_role` text NOT NULL,
  `applied_at` integer NOT NULL,
  `observed_at` integer,
  `outcome` text
);

CREATE INDEX `idx_sub_role_training_moves_restaurant` ON `sub_role_training_moves`(`restaurant_id`);
CREATE INDEX `idx_sub_role_training_moves_applied_at` ON `sub_role_training_moves`(`applied_at`);
