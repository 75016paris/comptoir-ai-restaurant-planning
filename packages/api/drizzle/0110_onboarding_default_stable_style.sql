-- New restaurant onboarding should default to the stable-team staffing preset.
-- Keep already-completed restaurants unchanged; update only in-flight funnels that
-- still carry the previous default.
UPDATE restaurants
SET preferred_style = 'equipe-stable'
WHERE onboarding_completed_at IS NULL
  AND preferred_style = 'equilibre';
