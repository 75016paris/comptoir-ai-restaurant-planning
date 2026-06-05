-- Unify staffing role model.
-- Removes subRoleMode (3 modes), chefRequiredZones, and the isChef/isSousChef user booleans.
-- Sub-roles become the single source of truth. The solver handles
-- Sous-chef → Chef promotion via string matching on subRoles arrays.

-- Step 1 ── Merge is_chef / is_sous_chef flags into sub_roles JSON arrays.
-- Kitchen users: "Chef" / "Sous-chef". Salle users: "Chef de rang" / "Sous-chef de rang".

UPDATE users SET sub_roles = json_insert(COALESCE(sub_roles, '[]'), '$[#]', 'Chef')
WHERE role = 'kitchen' AND is_chef = 1
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(users.sub_roles, '[]')) WHERE value = 'Chef');

UPDATE users SET sub_roles = json_insert(COALESCE(sub_roles, '[]'), '$[#]', 'Sous-chef')
WHERE role = 'kitchen' AND is_sous_chef = 1
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(users.sub_roles, '[]')) WHERE value = 'Sous-chef');

UPDATE users SET sub_roles = json_insert(COALESCE(sub_roles, '[]'), '$[#]', 'Chef de rang')
WHERE role = 'salle' AND is_chef = 1
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(users.sub_roles, '[]')) WHERE value = 'Chef de rang');

UPDATE users SET sub_roles = json_insert(COALESCE(sub_roles, '[]'), '$[#]', 'Sous-chef de rang')
WHERE role = 'salle' AND is_sous_chef = 1
  AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(users.sub_roles, '[]')) WHERE value = 'Sous-chef de rang');

-- Step 2 ── Narrow restaurant sub-role default lists.
-- Only update restaurants still on the old long defaults (preserves customized lists).
UPDATE restaurants SET kitchen_sub_roles = '["Chef","Cuisinier"]'
WHERE kitchen_sub_roles = '["Chef","Sous-chef","Cuisinier","Plongeur"]';

UPDATE restaurants SET salle_sub_roles = '["Chef de rang","Serveur"]'
WHERE salle_sub_roles = '["Chef de rang","Sous-chef de rang","Serveur","Runner","Barman"]';

-- Step 3 ── Drop dead columns.
ALTER TABLE restaurants DROP COLUMN sub_role_mode;
ALTER TABLE restaurants DROP COLUMN chef_required_zones;
ALTER TABLE users DROP COLUMN is_chef;
ALTER TABLE users DROP COLUMN is_sous_chef;
