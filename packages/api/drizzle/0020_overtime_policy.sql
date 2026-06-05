ALTER TABLE restaurants ADD COLUMN overtime_mode TEXT NOT NULL DEFAULT 'flexible';
ALTER TABLE restaurants ADD COLUMN overtime_weekly_cap INTEGER NOT NULL DEFAULT 48;
ALTER TABLE restaurants ADD COLUMN overtime_distribution TEXT NOT NULL DEFAULT 'willing-first';
