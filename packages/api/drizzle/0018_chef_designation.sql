-- Chef designation: mark workers as chefs + toggle to require chef per shift
ALTER TABLE users ADD COLUMN is_chef INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN require_chef_per_shift INTEGER NOT NULL DEFAULT 0;
