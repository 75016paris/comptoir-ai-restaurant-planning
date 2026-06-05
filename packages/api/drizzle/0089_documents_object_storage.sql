-- Phase B of the OVH Object Storage migration. Additive only — every existing
-- row keeps storage_provider NULL and is still served from documents.data.
-- Phase C teaches the routes to write storage_provider='ovh' for new uploads;
-- Phase D backfills existing rows; Phase E nulls documents.data once safe.
ALTER TABLE documents ADD COLUMN storage_provider TEXT;
ALTER TABLE documents ADD COLUMN storage_key TEXT;
ALTER TABLE documents ADD COLUMN storage_status TEXT NOT NULL DEFAULT 'ready';
