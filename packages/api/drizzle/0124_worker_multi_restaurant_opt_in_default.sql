-- Worker-side global opt-in for cross-restaurant proposals is now enabled by default.
-- Restaurant-specific shares still require an explicit owner/admin authorization row.
UPDATE users
SET multi_restaurant_willing = 1
WHERE role IN ('kitchen', 'floor')
  AND active = 1;

UPDATE worker_restaurant_profiles
SET multi_restaurant_willing = 1
WHERE user_id IN (
  SELECT id
  FROM users
  WHERE role IN ('kitchen', 'floor')
    AND active = 1
);
