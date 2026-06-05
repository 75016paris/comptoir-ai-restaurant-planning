-- Track pending cancellation date (soft cancel — access continues until this date)
ALTER TABLE restaurants ADD COLUMN cancel_at TEXT;
