-- Phase E of the OVH Object Storage migration. Clears the legacy base64
-- payload for any document already on OVH so `documents.data` only carries
-- bytes for unbackfilled pre-Phase-C rows. The column stays NOT NULL with an
-- empty string sentinel — dropping it requires table recreation and a
-- guarantee that every row is backfilled, which we keep deferrable.
--
-- New uploads after this migration land on OVH only (storageKey path); the
-- legacy `data` ingestion branch is removed in code.

UPDATE documents
SET data = ''
WHERE storage_provider = 'ovh' AND storage_key IS NOT NULL;
