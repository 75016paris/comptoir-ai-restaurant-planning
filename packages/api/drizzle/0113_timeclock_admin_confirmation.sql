ALTER TABLE time_clocks ADD COLUMN admin_confirmed_at TEXT;
ALTER TABLE time_clocks ADD COLUMN admin_confirmed_by TEXT REFERENCES users(id);
