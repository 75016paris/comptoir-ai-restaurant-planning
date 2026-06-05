-- Track when a contract document was signed (for type='contract' docs).
-- Other document types leave signed_at null. When set, the UI displays the
-- document as "signé le YYYY-MM-DD" and it counts toward onboarding completion.

ALTER TABLE documents ADD COLUMN signed_at TEXT;
