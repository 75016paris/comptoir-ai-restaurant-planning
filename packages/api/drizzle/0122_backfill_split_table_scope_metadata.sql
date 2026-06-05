-- Backfill Phase 7 split-table scope metadata introduced by 0121.
--
-- Existing rows were created while the app was still single-restaurant by
-- construction. Use the legacy user restaurant first, then the unique active
-- restaurant membership when available, so old operational messages can be
-- exported without guessing during physical owner DB extraction.

UPDATE notifications
SET restaurant_id = (
  SELECT u.restaurant_id
  FROM users u
  WHERE u.id = notifications.recipient_id
)
WHERE restaurant_id IS NULL
  AND type NOT IN ('trial_ending', 'payment_failed', 'subscription_cancelled')
  AND EXISTS (
    SELECT 1
    FROM users u
    WHERE u.id = notifications.recipient_id
      AND u.restaurant_id IS NOT NULL
  );

UPDATE notifications
SET restaurant_id = (
  SELECT rm.restaurant_id
  FROM restaurant_memberships rm
  WHERE rm.user_id = notifications.recipient_id
    AND rm.active = 1
  ORDER BY rm.restaurant_id
  LIMIT 1
)
WHERE restaurant_id IS NULL
  AND type NOT IN ('trial_ending', 'payment_failed', 'subscription_cancelled')
  AND (
    SELECT COUNT(DISTINCT rm.restaurant_id)
    FROM restaurant_memberships rm
    WHERE rm.user_id = notifications.recipient_id
      AND rm.active = 1
  ) = 1;

UPDATE notifications
SET owner_id = (
  SELECT r.owner_id
  FROM restaurants r
  WHERE r.id = notifications.restaurant_id
)
WHERE owner_id IS NULL
  AND restaurant_id IS NOT NULL;

UPDATE notifications
SET owner_id = (
  SELECT om.owner_id
  FROM owner_memberships om
  WHERE om.user_id = notifications.recipient_id
  ORDER BY om.owner_id
  LIMIT 1
)
WHERE owner_id IS NULL
  AND type IN ('trial_ending', 'payment_failed', 'subscription_cancelled')
  AND (
    SELECT COUNT(DISTINCT om.owner_id)
    FROM owner_memberships om
    WHERE om.user_id = notifications.recipient_id
  ) = 1;

UPDATE chat_messages
SET restaurant_id = (
  SELECT u.restaurant_id
  FROM users u
  WHERE u.id = chat_messages.user_id
)
WHERE restaurant_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM users u
    WHERE u.id = chat_messages.user_id
      AND u.restaurant_id IS NOT NULL
  );

UPDATE chat_messages
SET restaurant_id = (
  SELECT rm.restaurant_id
  FROM restaurant_memberships rm
  WHERE rm.user_id = chat_messages.user_id
    AND rm.active = 1
  ORDER BY rm.restaurant_id
  LIMIT 1
)
WHERE restaurant_id IS NULL
  AND (
    SELECT COUNT(DISTINCT rm.restaurant_id)
    FROM restaurant_memberships rm
    WHERE rm.user_id = chat_messages.user_id
      AND rm.active = 1
  ) = 1;

UPDATE chat_messages
SET context_kind = CASE
  WHEN restaurant_id IS NULL THEN 'pre_context'
  ELSE 'restaurant_context'
END
WHERE context_kind IS NULL;

UPDATE chat_messages
SET owner_id = (
  SELECT r.owner_id
  FROM restaurants r
  WHERE r.id = chat_messages.restaurant_id
)
WHERE owner_id IS NULL
  AND context_kind = 'restaurant_context'
  AND restaurant_id IS NOT NULL;

UPDATE cron_runs
SET scope = 'fleet'
WHERE scope IS NULL;
