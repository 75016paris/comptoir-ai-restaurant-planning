-- Planning publication workflow defaults.
-- 3 weeks gives owners enough review time before the HCR 15-day publication deadline.
UPDATE restaurants
SET auto_staffing_weeks = 3
WHERE auto_staffing_weeks = 0;
