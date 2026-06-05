-- Rename `swap_requests` table → `replacement_requests` for clarity.
-- The two-way worker swap feature was removed 2026-04-27 (id:e8a2);
-- the table now backs the owner-mediated replacement flow exclusively.
-- SQLite 3.25+ auto-updates FK references on RENAME TABLE.
--
-- Enum values stored as data (`services.status = 'swap_pending'`,
-- `notifications.type = 'swap_*'`, `audit_logs.table_name = 'swap_requests'`)
-- stay as legacy strings; renaming those needs row-level UPDATEs and is
-- deferred to a follow-up migration.

ALTER TABLE swap_requests RENAME TO replacement_requests;
ALTER TABLE documents RENAME COLUMN swap_request_id TO replacement_request_id;
