ALTER TABLE restaurants ADD COLUMN include_silae_in_monthly_digest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN silae_codes TEXT NOT NULL DEFAULT '{}';
