-- Add sous-chef flag to users table
ALTER TABLE users ADD COLUMN is_sous_chef INTEGER NOT NULL DEFAULT 0;
