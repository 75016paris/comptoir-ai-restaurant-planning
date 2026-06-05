-- Restaurant SIRET (14 digits) — required column on URSSAF DPAE filings.
-- Nullable: existing restaurants haven't supplied it yet; admin sets it from Préférences > Profil.
-- Synced to Stripe customer metadata on update so SIRET shows up alongside billing.
ALTER TABLE restaurants ADD COLUMN siret TEXT;
