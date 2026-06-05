-- Per-employee owner override of the weekly OT cap (surcharges restaurants.overtime_weekly_cap for that specific employee).
-- Null = no override, use worker preference (users.max_weekly_hours) or global rule.
ALTER TABLE users ADD COLUMN owner_ot_override INTEGER;
