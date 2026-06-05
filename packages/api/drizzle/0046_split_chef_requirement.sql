-- Split requireChefPerService into per-role booleans
ALTER TABLE restaurants ADD COLUMN require_chef_cuisine INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN require_chef_salle INTEGER NOT NULL DEFAULT 0;

-- Migrate existing data: if old flag was on, enable both
UPDATE restaurants SET require_chef_cuisine = require_chef_per_service, require_chef_salle = require_chef_per_service;

-- Drop old column (SQLite doesn't support DROP COLUMN before 3.35, but Bun ships 3.43+)
ALTER TABLE restaurants DROP COLUMN require_chef_per_service;
