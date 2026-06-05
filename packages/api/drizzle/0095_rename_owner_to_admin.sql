-- Phase 1 of the owner→admin rename. Pure data + column-name pass; CHECK
-- constraints are TS-level only (drizzle text-enum doesn't emit SQL CHECK),
-- so no table rebuilds needed.
--
-- Audit log rows pre-dating the rename keep the legacy "bot:owner" string
-- bucket so the rows are simply migrated forward (no history break here,
-- unlike the swap→replacement case).

-- Role value on users
UPDATE users SET role = 'admin' WHERE role = 'owner';

-- Replacement-request status
UPDATE replacement_requests
SET status = 'awaiting_admin_decision'
WHERE status = 'awaiting_owner_decision';

-- Holiday-request source (admin-proposed reverse-flow leave)
UPDATE holiday_requests
SET source = 'admin_proposal'
WHERE source = 'owner_proposal';

-- Audit-log source label
UPDATE audit_logs
SET source = 'bot:admin'
WHERE source = 'bot:owner';

-- Column renames
ALTER TABLE users RENAME COLUMN owner_ot_override TO admin_ot_override;
ALTER TABLE restaurants RENAME COLUMN tap_in_out_owner_confirmation TO tap_in_out_admin_confirmation;
ALTER TABLE replacement_requests RENAME COLUMN owner_notified_at TO admin_notified_at;
ALTER TABLE pending_registrations RENAME COLUMN owner_name TO admin_name;
ALTER TABLE restriction_requests RENAME COLUMN owner_note TO admin_note;
ALTER TABLE sub_role_training_costs RENAME COLUMN owner_override TO admin_override;
