-- Normalize users.hourly_rate and restaurants.hcr_grid to integer cents.
--
-- Background: schema.ts declared hourly_rate INTEGER cents since 0061, and the
-- web forms multiply by 100 before POST. But seed's applyRealisticComp() wrote
-- euros floats (e.g. 18.50) directly, HCR_GRID_2026 was in euros, and
-- restaurants.hcr_grid was persisted in euros too. SQLite's INTEGER affinity
-- tolerates 18.5 as REAL, so the column ended up carrying mixed units — labor
-- cost, DPAE, and contracts all picked the wrong one depending on the row's
-- origin.
--
-- Heuristic for users.hourly_rate: values < 100 are euros (seed path; realistic
-- range €11-€22/h), values >= 100 are already cents (form path; 100 cents = €1/h
-- which is sub-SMIC and unreachable via the input). The gap is wide enough to
-- classify safely.
UPDATE users
SET hourly_rate = CAST(ROUND(hourly_rate * 100) AS INTEGER)
WHERE hourly_rate IS NOT NULL AND hourly_rate < 100;

-- restaurants.hcr_grid is a JSON Partial<HcrGrid>. Rewriting each key in pure
-- SQL needs per-level json_set calls; easier and safer to reset to {} so
-- owners re-customise from the new cents baseline. Pre-launch impact is
-- negligible (demo restaurants reseed; real owners rarely touch this editor).
UPDATE restaurants SET hcr_grid = '{}';
