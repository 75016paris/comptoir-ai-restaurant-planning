-- Worker-uploaded dossier documents must be confirmed by an admin/manager
-- before the checklist counts them toward "ready for DPAE". reviewed_at is
-- the gate; reviewed_by is informational. Backfill existing rows so we
-- don't suddenly flag everything in prod as pending review.
ALTER TABLE documents ADD COLUMN reviewed_at TEXT;
ALTER TABLE documents ADD COLUMN reviewed_by TEXT REFERENCES users(id);

UPDATE documents SET reviewed_at = created_at WHERE reviewed_at IS NULL;
