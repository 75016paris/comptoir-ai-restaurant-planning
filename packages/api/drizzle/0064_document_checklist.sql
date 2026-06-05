-- Document onboarding checklist fields.
-- requirement_key: slug like "id_card", "vital_card", "residence_proof", "medical_cert", "haccp", "work_permit".
--   Null for legacy / ad-hoc documents not tied to a required item.
-- issued_at: when the document was issued (YYYY-MM-DD) — used to validate recency (e.g. justif de domicile < 3 mois).
-- expires_at: when the document expires (YYYY-MM-DD) — used for renewal reminders (medical cert, HACCP, work permit).

ALTER TABLE documents ADD COLUMN requirement_key TEXT;
ALTER TABLE documents ADD COLUMN issued_at TEXT;
ALTER TABLE documents ADD COLUMN expires_at TEXT;
