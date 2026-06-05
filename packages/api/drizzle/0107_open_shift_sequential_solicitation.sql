ALTER TABLE open_shifts ADD COLUMN solicited_candidate_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE open_shifts ADD COLUMN last_solicited_at TEXT;
