-- Add zones JSON column to worker_availability and worker_preferred_schedule
-- Stores per-zone availability keyed by shift template zone name
-- e.g. {"Matin": true, "Continu": false, "Après-midi": true, "Soir": false}

ALTER TABLE worker_availability ADD COLUMN zones TEXT NOT NULL DEFAULT '{}';
ALTER TABLE worker_preferred_schedule ADD COLUMN zones TEXT NOT NULL DEFAULT '{}';
