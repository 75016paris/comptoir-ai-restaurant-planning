-- Phase 7 draft baseline for the global control-plane database.
-- This file is not wired to runtime migrations yet.

CREATE TABLE login_identities (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  user_notice_version TEXT,
  user_notice_accepted_at TEXT,
  user_notice_ip_address TEXT,
  user_notice_user_agent TEXT,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
  whatsapp_opt_in_at TEXT,
  whatsapp_opt_out_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE owners (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  database_path TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'active',
  subscription_period_end TEXT,
  trial_ends_at TEXT,
  cancel_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE owner_memberships (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, user_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  active_owner_id TEXT REFERENCES owners(id),
  active_restaurant_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  token TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE pending_registrations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_name TEXT NOT NULL,
  first_restaurant_name TEXT NOT NULL,
  admin_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE owner_legal_acceptances (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  acceptance_type TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  dpa_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  subprocessors_version TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE phone_routes (
  phone TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  restaurant_id TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (phone, user_id, owner_id, restaurant_id)
);

CREATE TABLE whatsapp_context_sessions (
  phone TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  restaurant_id TEXT NOT NULL,
  selected_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES login_identities(id),
  owner_id TEXT REFERENCES owners(id),
  restaurant_id TEXT,
  type TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES login_identities(id),
  owner_id TEXT REFERENCES owners(id),
  context_kind TEXT NOT NULL DEFAULT 'pre_context',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY NOT NULL,
  job_name TEXT NOT NULL,
  owner_id TEXT REFERENCES owners(id),
  scope TEXT NOT NULL DEFAULT 'fleet',
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  result TEXT
);

CREATE INDEX idx_master_owner_memberships_user ON owner_memberships(user_id);
CREATE INDEX idx_master_sessions_user ON sessions(user_id);
CREATE INDEX idx_master_sessions_owner ON sessions(active_owner_id);
CREATE INDEX idx_master_phone_routes_phone ON phone_routes(phone, active);
CREATE INDEX idx_master_whatsapp_context_expires ON whatsapp_context_sessions(expires_at);
CREATE INDEX idx_master_notifications_owner ON notifications(owner_id, created_at);
CREATE INDEX idx_master_chat_messages_user ON chat_messages(user_id, created_at);
CREATE INDEX idx_master_cron_runs_scope ON cron_runs(scope, started_at);
