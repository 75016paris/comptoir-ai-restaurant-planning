-- France/HCR default: new full-time employee contracts start at 39h.
-- Existing restaurants at the old app default are moved to the new default;
-- restaurant-specific custom values stay untouched.
UPDATE restaurants
SET default_contract_hours = 39
WHERE default_contract_hours = 35;

