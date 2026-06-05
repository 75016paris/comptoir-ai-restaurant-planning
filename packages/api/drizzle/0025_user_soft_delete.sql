-- Soft delete for workers — deactivated users hidden from UI but kept for payroll history
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
