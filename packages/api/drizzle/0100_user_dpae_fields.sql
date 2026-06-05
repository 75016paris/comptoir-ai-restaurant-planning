-- DPAE-mandatory worker fields the URSSAF declaration requires that we weren't capturing.
-- Stored once on the user row instead of being collected ad-hoc at export time, so the
-- worker can fill them in from /my-profile and the admin can run DPAE without prompts.
-- NIR is the French social-security number ("numéro de sécurité sociale", 13 digits + key).
ALTER TABLE users ADD COLUMN date_of_birth TEXT;       -- YYYY-MM-DD
ALTER TABLE users ADD COLUMN birth_place TEXT;         -- ville, département (free text)
ALTER TABLE users ADD COLUMN nationality TEXT;         -- ISO-ish code, default "FR" applied in app layer
ALTER TABLE users ADD COLUMN nir TEXT;                 -- 13 digits + 2-digit key, may stay null until URSSAF assigns one
