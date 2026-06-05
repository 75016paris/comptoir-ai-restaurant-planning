-- Store Stripe cancellation feedback for internal churn/audit follow-up.
ALTER TABLE restaurants ADD COLUMN cancellation_reason TEXT;
ALTER TABLE restaurants ADD COLUMN cancellation_feedback TEXT;
ALTER TABLE restaurants ADD COLUMN cancellation_comment TEXT;
ALTER TABLE restaurants ADD COLUMN cancellation_requested_at TEXT;
