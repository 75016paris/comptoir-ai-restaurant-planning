-- First-login password change gate (id:8c1d).
-- New workers are created with the provisional "comptoir123" password; this flag
-- forces them to swap it on first login before accessing the rest of the app.
-- Existing users default to 0 (already set their own password).

ALTER TABLE `users` ADD COLUMN `must_change_password` INTEGER NOT NULL DEFAULT 0;
