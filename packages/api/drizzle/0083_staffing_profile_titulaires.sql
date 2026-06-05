-- Per-worker titulaire roster per staffing profile.
-- Used as a manual seed for the équipe-stable preset on new restaurants
-- that have no historical schedule for the consistency map to anchor on.
ALTER TABLE staffing_profiles ADD COLUMN preferred_worker_ids TEXT NOT NULL DEFAULT '[]';
