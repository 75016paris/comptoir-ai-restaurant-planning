-- Baseline solver cache invalidation counter. Bumped from mutation routes
-- that change inputs the multi-week solver depends on (targets, templates,
-- workers, availability, closures, services, holidays). Folded into the
-- cache key as a belt-and-suspenders guard on top of per-table checksums.

ALTER TABLE `restaurants` ADD COLUMN `cache_version` integer NOT NULL DEFAULT 0;
