-- Dynamic shift zones: allow N named shift groups instead of hardcoded midi/soir
-- Add sort_order to shift_templates for display ordering
ALTER TABLE shift_templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Backfill sort_order from existing zone values
UPDATE shift_templates SET sort_order = CASE
  WHEN zone = 'midi' THEN 1
  WHEN zone = 'soir' THEN 2
  ELSE 0
END;
