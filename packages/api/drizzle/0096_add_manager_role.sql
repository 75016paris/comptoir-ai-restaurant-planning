-- Phase 2 of the owner→admin/manager refactor: introduce the executive
-- "manager" tier (FR: "Responsable") and per-user permission overrides.
--
-- Manager is a third role between admin and worker:
--   - Off-schedule (no staffing_targets impact, no zone)
--   - Default permissions: planning_edit, swap/leave approve, team/hours view, publish_week
--   - Default refusals:    billing, restaurant_settings, manage_roles
--   - Admin can flip individual permissions in the manager's Profil page
--
-- The role enum (admin | kitchen | salle) widens to include 'manager'. SQLite
-- doesn't enforce the drizzle text-enum CHECK at the DB layer, so no DDL is
-- needed for the enum widening — it's purely a TS-level constraint update.
--
-- The new `permissions` column is JSON; null means "use role defaults".

ALTER TABLE users ADD COLUMN permissions TEXT;
