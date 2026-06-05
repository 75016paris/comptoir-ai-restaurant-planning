-- Per-dimension semantic overrides on top of preferred_style. JSON of
-- TunableDimension → SemanticLevel (0..4). Missing keys inherit from preset.
-- See packages/shared/src/weight-config.ts (SEMANTIC_SCALE, resolveWeights).

ALTER TABLE restaurants ADD COLUMN custom_weights TEXT;
