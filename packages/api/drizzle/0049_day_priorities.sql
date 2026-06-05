-- Add per-day priority to staffing profiles (JSON: {"1":2,"5":1,"6":1})
ALTER TABLE staffing_profiles ADD COLUMN day_priorities TEXT NOT NULL DEFAULT '{}';
