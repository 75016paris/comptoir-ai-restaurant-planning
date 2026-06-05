-- Move roleBasedStaffing from restaurant-level to per-profile
ALTER TABLE staffing_profiles ADD COLUMN role_based_staffing INTEGER NOT NULL DEFAULT 0;
