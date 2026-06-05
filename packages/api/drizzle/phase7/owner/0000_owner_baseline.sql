-- Phase 7 draft baseline for a single owner data database.
-- This file is not wired to runtime migrations yet.

CREATE TABLE restaurants (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  siret TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
  status TEXT NOT NULL DEFAULT 'active',
  open_days TEXT NOT NULL DEFAULT '[2,3,4,5,6,7]',
  medical_mode INTEGER NOT NULL DEFAULT 0,
  tap_in_out_enabled INTEGER NOT NULL DEFAULT 0,
  tap_in_out_admin_confirmation INTEGER NOT NULL DEFAULT 0,
  tap_in_out_mode TEXT NOT NULL DEFAULT 'lateness_only',
  tap_in_counts_as_hours INTEGER NOT NULL DEFAULT 0,
  reminder_frequency TEXT NOT NULL DEFAULT 'off',
  color_scheme TEXT NOT NULL DEFAULT 'classic',
  kitchen_color TEXT NOT NULL DEFAULT 'amber',
  floor_color TEXT NOT NULL DEFAULT 'sky',
  worker_preferences_enabled INTEGER NOT NULL DEFAULT 1,
  auto_staffing_weeks INTEGER NOT NULL DEFAULT 3,
  disabled_compliance_rules TEXT NOT NULL DEFAULT '["HCR-L3121-16"]',
  kitchen_sub_roles TEXT NOT NULL DEFAULT '["Chef","Cuisinier"]',
  floor_sub_roles TEXT NOT NULL DEFAULT '["Chef de rang","Serveur"]',
  overtime_mode TEXT NOT NULL DEFAULT 'flexible',
  overtime_weekly_cap INTEGER NOT NULL DEFAULT 48,
  overtime_distribution TEXT NOT NULL DEFAULT 'willing-first',
  hcr_grid TEXT NOT NULL DEFAULT '{}',
  subrole_hcr_map TEXT NOT NULL DEFAULT '{}',
  default_contract_type TEXT NOT NULL DEFAULT 'CDI',
  default_contract_hours INTEGER NOT NULL DEFAULT 39,
  preferred_style TEXT NOT NULL DEFAULT 'equipe-stable',
  custom_weights TEXT,
  latitude REAL,
  longitude REAL,
  cache_version INTEGER NOT NULL DEFAULT 0,
  onboarding_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner-local user projection only. Login email/password stay in the master DB.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE restaurant_memberships (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  permissions TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (restaurant_id, user_id)
);

CREATE TABLE worker_restaurant_profiles (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  priority INTEGER NOT NULL DEFAULT 1,
  sub_roles TEXT NOT NULL DEFAULT '[]',
  contract_type TEXT,
  contract_hours INTEGER,
  contract_end_date TEXT,
  max_weekly_hours INTEGER,
  admin_ot_override INTEGER,
  hcr_level TEXT,
  hourly_rate INTEGER,
  matricule TEXT,
  manager_notes TEXT,
  multi_restaurant_willing INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (restaurant_id, user_id)
);

CREATE TABLE worker_share_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  source_restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  target_restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  worker_consented_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE services (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  source TEXT NOT NULL DEFAULT 'manual',
  filled_as TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  holiday_request_id TEXT,
  replacement_request_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '',
  storage_provider TEXT,
  storage_key TEXT,
  storage_status TEXT NOT NULL DEFAULT 'ready',
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  requirement_key TEXT,
  issued_at TEXT,
  expires_at TEXT,
  signed_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE time_clocks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  service_id TEXT REFERENCES services(id),
  tap_in TEXT NOT NULL,
  tap_out TEXT,
  date TEXT NOT NULL,
  admin_confirmed_at TEXT,
  admin_confirmed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE holiday_requests (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  medical INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'worker',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE replacement_requests (
  id TEXT PRIMARY KEY NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id),
  requester_service_id TEXT NOT NULL REFERENCES services(id),
  target_id TEXT REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  status TEXT NOT NULL DEFAULT 'awaiting_admin_decision',
  message TEXT,
  responded_at TEXT,
  expires_at TEXT NOT NULL,
  candidate_ids TEXT,
  candidate_scores TEXT,
  admin_notified_at TEXT,
  worker_notified_at TEXT,
  escalation_count INTEGER NOT NULL DEFAULT 0,
  rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
  medical INTEGER NOT NULL DEFAULT 0,
  itt_reminder_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE open_shifts (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  role TEXT NOT NULL,
  required_sub_roles TEXT NOT NULL DEFAULT '[]',
  message TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]',
  rejected_candidate_ids TEXT NOT NULL DEFAULT '[]',
  solicited_candidate_ids TEXT NOT NULL DEFAULT '[]',
  last_solicited_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT REFERENCES users(id),
  claimed_at TEXT,
  service_id TEXT REFERENCES services(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT REFERENCES restaurants(id),
  type TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE admin_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,
  worker_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  actor_name TEXT,
  source TEXT NOT NULL,
  changes TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE daily_revenue (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE restaurant_closures (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT,
  schedule TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE service_templates (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT,
  role TEXT NOT NULL,
  zone TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE service_template_overrides (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES service_templates(id),
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE worker_availability (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  midi INTEGER NOT NULL DEFAULT 0,
  soir INTEGER NOT NULL DEFAULT 0,
  midi_start TEXT,
  midi_end TEXT,
  soir_start TEXT,
  soir_end TEXT,
  continuous INTEGER NOT NULL DEFAULT 0,
  zones TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE worker_restrictions (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  start_time TEXT,
  end_time TEXT,
  reason TEXT,
  effective_from TEXT,
  effective_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE restriction_requests (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL,
  effective_from TEXT,
  effective_until TEXT,
  restrictions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  admin_note TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE worker_preferred_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  midi INTEGER NOT NULL DEFAULT 0,
  soir INTEGER NOT NULL DEFAULT 0,
  zones TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE staffing_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  day_priorities TEXT NOT NULL DEFAULT '{}',
  preferred_assignments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE staffing_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT NOT NULL REFERENCES staffing_profiles(id),
  year INTEGER NOT NULL,
  week INTEGER NOT NULL
);

CREATE TABLE staffing_targets (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT REFERENCES staffing_profiles(id),
  day_of_week INTEGER NOT NULL,
  role TEXT NOT NULL,
  zone TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  role_breakdown TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  end_date TEXT,
  name TEXT NOT NULL,
  zone TEXT,
  year INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE onboarding_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT REFERENCES restaurants(id),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  restaurant_id TEXT REFERENCES restaurants(id),
  context_kind TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE weather_data (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  weather_code INTEGER,
  temp_max REAL,
  temp_min REAL,
  sunrise TEXT,
  sunset TEXT,
  normal_temp_max REAL,
  normal_temp_min REAL,
  hourly_weather_codes TEXT,
  hourly_temperatures TEXT,
  is_forecast INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE contract_templates (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  body_html TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE published_weeks (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  week_date TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE email_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  send_monthly_digest INTEGER NOT NULL DEFAULT 0,
  send_leave_alerts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE worker_weekly_hours (
  worker_id TEXT NOT NULL REFERENCES users(id),
  week_start TEXT NOT NULL,
  hours_actual REAL NOT NULL,
  recorded_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'services',
  PRIMARY KEY (worker_id, week_start)
);

CREATE TABLE sub_role_training_costs (
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  cost_points REAL NOT NULL,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL,
  admin_override INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, from_role, to_role)
);

CREATE TABLE sub_role_training_moves (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  worker_id TEXT NOT NULL REFERENCES users(id),
  move_type TEXT NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  observed_at INTEGER,
  outcome TEXT
);

CREATE TABLE staffing_analysis_cache (
  id TEXT PRIMARY KEY NOT NULL,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  profile_id TEXT,
  horizon_weeks INTEGER NOT NULL,
  base_monday TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  result TEXT,
  error TEXT
);

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'owner',
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  result TEXT
);

CREATE INDEX idx_owner_users_phone ON users(phone);
CREATE INDEX idx_owner_memberships_user ON restaurant_memberships(user_id, active);
CREATE INDEX idx_owner_services_restaurant_date ON services(restaurant_id, date);
CREATE INDEX idx_owner_documents_restaurant_user ON documents(restaurant_id, user_id);
CREATE INDEX idx_owner_audit_logs_restaurant ON audit_logs(restaurant_id, created_at);
