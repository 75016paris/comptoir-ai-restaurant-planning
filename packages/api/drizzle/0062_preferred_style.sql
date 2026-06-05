-- Named optimizer-weight preset chosen by the owner.
-- Maps to a WeightConfig in packages/shared/src/weight-config.ts.
-- Default "equilibre" = the v1 calibrated weights (2026-04-17 sweep winner).

ALTER TABLE restaurants ADD COLUMN preferred_style TEXT NOT NULL DEFAULT 'equilibre'
  CHECK (preferred_style IN ('equilibre','equipe-stable','equite-max','flexibilite','ot-friendly'));
