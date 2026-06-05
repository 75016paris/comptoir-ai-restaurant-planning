ALTER TABLE notifications ADD COLUMN owner_id TEXT REFERENCES owners(id);
ALTER TABLE notifications ADD COLUMN restaurant_id TEXT REFERENCES restaurants(id);

ALTER TABLE chat_messages ADD COLUMN owner_id TEXT REFERENCES owners(id);
ALTER TABLE chat_messages ADD COLUMN restaurant_id TEXT REFERENCES restaurants(id);
ALTER TABLE chat_messages ADD COLUMN context_kind TEXT;

ALTER TABLE cron_runs ADD COLUMN owner_id TEXT REFERENCES owners(id);
ALTER TABLE cron_runs ADD COLUMN scope TEXT;
