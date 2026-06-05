ALTER TABLE restaurants ADD COLUMN kitchen_color TEXT NOT NULL DEFAULT 'amber';
ALTER TABLE restaurants ADD COLUMN salle_color TEXT NOT NULL DEFAULT 'sky';
-- Migrate existing color_scheme to independent picks
UPDATE restaurants SET kitchen_color = 'amber', salle_color = 'sky' WHERE color_scheme = 'classic' OR color_scheme = 'garden';
UPDATE restaurants SET kitchen_color = 'lime', salle_color = 'violet' WHERE color_scheme = 'sunset' OR color_scheme = 'candy';
UPDATE restaurants SET kitchen_color = 'teal', salle_color = 'amber' WHERE color_scheme = 'ocean';
UPDATE restaurants SET kitchen_color = 'sky', salle_color = 'emerald' WHERE color_scheme = 'earth';
