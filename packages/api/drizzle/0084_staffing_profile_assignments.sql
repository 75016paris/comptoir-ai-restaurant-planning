-- Replaces the flat preferred_worker_ids JSON with per-slot pinning so the
-- équipe-stable preset can carry "Brad on Mon-soir + Tue-soir + Wed-coupure"
-- shape, not just "Brad is preferred somewhere this week".
--
-- Stored as JSON: [{"workerId":"…","dayOfWeek":1..7,"zone":"Soir","role":"kitchen"|"salle"}, …]
-- A worker may appear in multiple entries.
ALTER TABLE staffing_profiles ADD COLUMN preferred_assignments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE staffing_profiles DROP COLUMN preferred_worker_ids;
