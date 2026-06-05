-- Final pass on the swap → replacement rename: column enum values.
-- Migration 0090 renamed the table; this migrates the data values that
-- continued to carry the legacy "swap" label.
--
-- Audit logs referencing the old table name are deleted (per user — those
-- rows pre-date the rename and we accept the audit-trail break for the
-- swap subset).

UPDATE services
SET status = 'replacement_pending'
WHERE status = 'swap_pending';

UPDATE notifications
SET type = 'replacement_proposal'
WHERE type = 'swap_proposal';

UPDATE notifications
SET type = 'replacement_accepted'
WHERE type = 'swap_accepted';

UPDATE notifications
SET type = 'replacement_rejected'
WHERE type = 'swap_rejected';

UPDATE notifications
SET type = 'replacement_expired'
WHERE type = 'swap_expired';

UPDATE notifications
SET type = 'replacement_request'
WHERE type = 'swap_request';

DELETE FROM audit_logs WHERE table_name = 'swap_requests';
