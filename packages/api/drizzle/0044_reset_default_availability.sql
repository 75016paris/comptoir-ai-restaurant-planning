-- Migration: reset availability to "available by default"
-- Old model: empty/all-false zones = unavailable (opt-in default)
-- New model: no rows = available everywhere (restriction-based)
-- Delete rows where all zones are false or empty — these represent "never configured"
DELETE FROM worker_availability
WHERE zones = '{}'
   OR zones NOT LIKE '%true%';
