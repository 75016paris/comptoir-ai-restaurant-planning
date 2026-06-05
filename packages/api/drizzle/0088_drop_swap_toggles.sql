-- Drop the legacy swap-flow toggles. Replacement flow (2026-04-27) is always
-- owner-mediated, so swap_approval is structurally true and notify_on_swap is
-- always implied — the columns were never read outside settings/seed.
ALTER TABLE restaurants DROP COLUMN swap_approval;
ALTER TABLE restaurants DROP COLUMN notify_on_swap;
