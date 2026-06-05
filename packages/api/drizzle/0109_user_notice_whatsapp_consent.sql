ALTER TABLE users ADD COLUMN user_notice_version TEXT;
ALTER TABLE users ADD COLUMN user_notice_accepted_at TEXT;
ALTER TABLE users ADD COLUMN user_notice_ip_address TEXT;
ALTER TABLE users ADD COLUMN user_notice_user_agent TEXT;
ALTER TABLE users ADD COLUMN whatsapp_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN whatsapp_opt_in_at TEXT;
ALTER TABLE users ADD COLUMN whatsapp_opt_out_at TEXT;
