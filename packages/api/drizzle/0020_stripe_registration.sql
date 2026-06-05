-- Stripe + registration fields on restaurants
ALTER TABLE restaurants ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE restaurants ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE restaurants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Pending registrations (before Stripe payment confirms)
CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY,
  restaurant_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
