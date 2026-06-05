-- Marginal revenue attributed to covering one otherwise-unfilled staffing slot
-- (in cents). Feeds the auto-optimize Phase 4 OT mode recommendation: a larger
-- OT mode is only proposed when the revenue gain beats the OT labor-cost delta.
-- Null = fall back to a hardcoded constant in ot-cost-delta.ts.

ALTER TABLE `restaurants` ADD COLUMN `revenue_per_covered_slot_cents` integer;
