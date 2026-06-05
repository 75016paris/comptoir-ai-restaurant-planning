ALTER TABLE users ADD COLUMN sub_roles TEXT NOT NULL DEFAULT '[]';
-- Migrate any existing sub_role data
UPDATE users SET sub_roles = '["' || sub_role || '"]' WHERE sub_role IS NOT NULL AND sub_role != '';
