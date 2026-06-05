ALTER TABLE worker_availability ADD COLUMN midi_start TEXT;
ALTER TABLE worker_availability ADD COLUMN midi_end TEXT;
ALTER TABLE worker_availability ADD COLUMN soir_start TEXT;
ALTER TABLE worker_availability ADD COLUMN soir_end TEXT;
ALTER TABLE worker_availability ADD COLUMN continuous INTEGER NOT NULL DEFAULT 0;
