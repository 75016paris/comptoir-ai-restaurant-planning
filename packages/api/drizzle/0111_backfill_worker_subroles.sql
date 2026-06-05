-- Backfill empty sub_roles on kitchen/floor workers so they all have at least
-- one position. Required because the API now rejects empty subRoles on
-- kitchen/floor create/update — without this, existing accounts could not be
-- patched after deploy.
--
-- Strategy: copy the restaurant's first configured sub-role for the matching
-- department. If the restaurant itself has no sub-roles configured, fall back
-- to a generic default ("Cuisinier" / "Serveur").

UPDATE users
SET sub_roles = json_array(
  COALESCE(
    (SELECT json_extract(r.kitchen_sub_roles, '$[0]')
     FROM restaurants r WHERE r.id = users.restaurant_id),
    'Cuisinier'
  )
)
WHERE role = 'kitchen'
  AND (sub_roles IS NULL OR sub_roles = '' OR sub_roles = '[]');

UPDATE users
SET sub_roles = json_array(
  COALESCE(
    (SELECT json_extract(r.floor_sub_roles, '$[0]')
     FROM restaurants r WHERE r.id = users.restaurant_id),
    'Serveur'
  )
)
WHERE role = 'floor'
  AND (sub_roles IS NULL OR sub_roles = '' OR sub_roles = '[]');
