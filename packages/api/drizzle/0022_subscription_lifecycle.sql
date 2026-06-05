-- Subscription lifecycle fields on restaurants
ALTER TABLE restaurants ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active';
-- Values: 'active', 'trialing', 'past_due', 'cancelled', 'unpaid'
-- Demo restaurants stay 'active' (no Stripe)

ALTER TABLE restaurants ADD COLUMN subscription_period_end TEXT;
-- ISO datetime — when current billing period ends

ALTER TABLE restaurants ADD COLUMN trial_ends_at TEXT;
-- ISO datetime — trial expiry (null = no trial)
