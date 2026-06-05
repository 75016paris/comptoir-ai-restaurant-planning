-- Drop the per-subrole vs flat-count toggle. Sub-role demand is now the single mode.
-- Backfill of empty role_breakdowns runs in scripts/backfill-role-breakdowns.ts BEFORE
-- this migration on every environment.
ALTER TABLE restaurants DROP COLUMN role_based_staffing;
ALTER TABLE staffing_profiles DROP COLUMN role_based_staffing;
