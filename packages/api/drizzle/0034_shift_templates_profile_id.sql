-- Per-profile shift templates: each staffing profile can have its own shift zones + times
ALTER TABLE shift_templates ADD COLUMN profile_id TEXT REFERENCES staffing_profiles(id);
