-- Existing open replacement requests may still carry the original request-created
-- deadline. For worker-reply rows, the answer window is anchored to when the
-- candidate was notified.
UPDATE replacement_requests
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', worker_notified_at, '+24 hours')
WHERE status = 'awaiting_worker_reply'
  AND worker_notified_at IS NOT NULL;
