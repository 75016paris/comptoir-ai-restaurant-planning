-- Role-based staffing: toggle, sub-role definitions, breakdown per target, employee sub-role
ALTER TABLE restaurants ADD COLUMN role_based_staffing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN kitchen_sub_roles TEXT NOT NULL DEFAULT '["Chef","Sous-chef","Cuisinier","Plongeur"]';
ALTER TABLE restaurants ADD COLUMN salle_sub_roles TEXT NOT NULL DEFAULT '["Chef de rang","Serveur","Runner","Barman"]';
ALTER TABLE staffing_targets ADD COLUMN role_breakdown TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN sub_role TEXT;
