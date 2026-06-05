-- Replace per-role chef booleans with per-zone JSON array
ALTER TABLE restaurants ADD COLUMN chef_required_zones TEXT NOT NULL DEFAULT '[]';

-- Migrate: build JSON array from old booleans + existing service template zones
-- If require_chef_cuisine was on, add all kitchen zones; same for salle
UPDATE restaurants SET chef_required_zones = (
  SELECT COALESCE(
    '[' || GROUP_CONCAT('"' || zone || '_' || role || '"') || ']',
    '[]'
  )
  FROM (
    SELECT DISTINCT st.zone, st.role
    FROM service_templates st
    WHERE st.restaurant_id = restaurants.id
      AND st.profile_id IS NULL
      AND (
        (st.role = 'kitchen' AND restaurants.require_chef_cuisine = 1)
        OR (st.role = 'salle' AND restaurants.require_chef_salle = 1)
      )
  )
);

ALTER TABLE restaurants DROP COLUMN require_chef_cuisine;
ALTER TABLE restaurants DROP COLUMN require_chef_salle;
