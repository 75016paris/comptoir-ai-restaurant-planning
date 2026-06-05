-- Track sub-role substitution on services so the UI can flag cross-fills
-- (e.g. "Sandra fills Cuisinier as Sous-chef"). Null = exact match or
-- restaurant doesn't use sub-role breakdowns.
ALTER TABLE services ADD COLUMN filled_as TEXT;
