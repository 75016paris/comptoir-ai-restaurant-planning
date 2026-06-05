-- HCR hourly rate grid (Convention Collective HCR, barème 2026) — per-restaurant override.
-- users.hcr_level + users.hourly_rate for per-employee assignment and rate override.

-- Per-restaurant customisation of the HCR grid (Partial<HcrGrid>) and sub-role → niveau default mapping.
ALTER TABLE restaurants ADD COLUMN hcr_grid TEXT NOT NULL DEFAULT '{}';
ALTER TABLE restaurants ADD COLUMN subrole_hcr_map TEXT NOT NULL DEFAULT '{}';
ALTER TABLE restaurants ADD COLUMN default_contract_type TEXT NOT NULL DEFAULT 'CDI' CHECK (default_contract_type IN ('CDI','CDD','saisonnier'));
ALTER TABLE restaurants ADD COLUMN default_contract_hours INTEGER NOT NULL DEFAULT 35;

-- Per-employee HCR assignment and rate override.
ALTER TABLE users ADD COLUMN hcr_level TEXT; -- e.g. "I-1" .. "V-3"; null = unassigned
ALTER TABLE users ADD COLUMN hourly_rate INTEGER; -- owner override in cents; null = resolve from grid[hcrLevel]
