-- Distinguish worker-submitted holidays from owner-proposed ones.
-- Owner proposals sit at status='pending' with source='owner_proposal' waiting for
-- the worker to accept (→ approved) or reject (→ rejected). Worker-submitted rows
-- keep the default source='worker' and the original owner-approves workflow.

ALTER TABLE `holiday_requests`
  ADD COLUMN `source` text NOT NULL DEFAULT 'worker';

CREATE INDEX IF NOT EXISTS `holiday_requests_worker_pending_idx`
  ON `holiday_requests` (`worker_id`, `status`, `source`);
