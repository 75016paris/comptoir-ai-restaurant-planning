-- Medical replacement requests: worker is sick and can't come.
-- ITT (Interruption Temporaire de Travail) document attached via documents.swap_request_id.

ALTER TABLE swap_requests ADD COLUMN medical INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swap_requests ADD COLUMN itt_reminder_sent_at TEXT;

-- Documents can now be linked to a replacement request (ITT/arrêt maladie).
ALTER TABLE documents ADD COLUMN swap_request_id TEXT REFERENCES swap_requests(id);
