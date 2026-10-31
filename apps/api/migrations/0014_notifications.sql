-- MM-T91 (owner decisions, Kyle 2026-10-31): in-app notifications, kept separate from action
-- requests. An action request (action_item, MM-T27) is work someone must do in the underlying
-- workflow; a notification only tells a person something happened. Reading, dismissing or
-- restoring a notification never touches the action item, its routing or the audit log.
--
-- Two kinds, both about an action request (no routine-event kinds yet):
--   action_request.opened   an action request now waits on you (created, reassigned or rerouted
--                           to you). The API writes one per person routed to the item, at most
--                           one per item per person: the unique (recipient, event_key) key. When
--                           an item moves to someone else, they get their own row; the old rows
--                           are never retargeted or deleted, and the list renders them live.
--   action_request.decided  someone else resolved a request you raised (cancellation, closure,
--                           retention or team join), or a correction you returned was marked
--                           done. Written by the trigger below on the open → resolved change, so
--                           every resolution path (API, SQL functions, triggers) is covered and
--                           concurrent resolvers produce one row. No notice for lead appointments
--                           or grant reviews, for a self-resolution, or for a requester who is
--                           disabled or not a personal/test account. Decline reasons are not
--                           copied: the list reads the item live.
--
-- Unread / read, "Mark all read", and dismiss (a reversible hide, which also marks it read).
-- Nothing is deleted. The list covers the last 90 days (an API constant, not a purge).

CREATE TABLE notification (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id  uuid NOT NULL REFERENCES app_user (id),
  kind               text NOT NULL,
  action_item_id     uuid REFERENCES action_item (id),
  -- What happened, once per recipient: 'action_item:<id>:opened' or 'action_item:<id>:decided'.
  event_key          text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz,
  dismissed_at       timestamptz,
  CONSTRAINT notification_kind_check
    CHECK (kind IN ('action_request.opened', 'action_request.decided')),
  -- Both current kinds are about one action item, and their key names it.
  CONSTRAINT notification_shape_check CHECK (
    CASE kind
      WHEN 'action_request.opened' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':opened'
      WHEN 'action_request.decided' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':decided'
      ELSE false
    END
  ),
  -- Dismissing also marks it read; restoring leaves it read.
  CONSTRAINT notification_dismissed_is_read CHECK (dismissed_at IS NULL OR read_at IS NOT NULL),
  CONSTRAINT notification_one_per_event UNIQUE (recipient_user_id, event_key)
);
-- The list (newest first) and the unread count, per person.
CREATE INDEX notification_recipient_created_idx
  ON notification (recipient_user_id, created_at DESC, id);
CREATE INDEX notification_recipient_unread_idx
  ON notification (recipient_user_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX notification_action_item_idx ON notification (action_item_id);

-- Only active personal (or test) accounts receive notifications: never LAB, never a disabled
-- account. The same rule as action_item_person_eligible and the email outbox recipients.
CREATE FUNCTION notification_recipient_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.id = NEW.recipient_user_id AND u.status = 'active'
      AND u.account_type IN ('personal', 'test')
  ) THEN
    RAISE EXCEPTION 'notifications go to active personal accounts only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_recipient_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_recipient_check
  BEFORE INSERT ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_recipient_check();

-- Rows are never deleted. Only the read state changes: read_at once (null → a time) and
-- dismissed_at between null and a time (dismiss / restore). Everything else is fixed.
CREATE FUNCTION notification_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'notifications can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.action_item_id IS DISTINCT FROM OLD.action_item_id
     OR NEW.event_key IS DISTINCT FROM OLD.event_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'notification % can only be read, dismissed or restored', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.read_at IS DISTINCT FROM OLD.read_at AND (OLD.read_at IS NOT NULL OR NEW.read_at IS NULL)
  THEN
    RAISE EXCEPTION 'notification % is read once and stays read', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
     AND OLD.dismissed_at IS NOT NULL AND NEW.dismissed_at IS NOT NULL THEN
    RAISE EXCEPTION 'notification % is already dismissed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_guard
  BEFORE UPDATE OR DELETE ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_guard();
CREATE TRIGGER notification_no_truncate
  BEFORE TRUNCATE ON notification
  FOR EACH STATEMENT EXECUTE FUNCTION notification_guard();

-- Decision notice: once, to the requester, when someone else resolves their request. The trigger
-- fires only on a real open → resolved row change, which action_item_guard allows once, so two
-- concurrent resolvers (one waits on the row lock, then finds it resolved) write one row; the
-- unique key is a second guard. The requester is created_by_user_id: the person who raised the
-- request, or for a correction the reviewer who returned it (the return event's user_id, which
-- review.service writes as created_by_user_id). A correction counts as marked done when it was
-- resolved by a correction_done review event (the API leaves its resolution empty) or carries the
-- correction_done resolution; one resolved by cancelling the test is not. LAB never raises any of
-- these kinds.
CREATE FUNCTION action_item_decided_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind IN ('cancellation_request', 'closure_request', 'retention_request',
                   'team_join_request')
      OR (NEW.kind = 'correction'
          AND (NEW.resolution = 'correction_done'
               OR EXISTS (SELECT 1 FROM test_request_review_event e
                          WHERE e.id = NEW.resolved_by_event_id AND e.kind = 'correction_done'))))
     AND NEW.resolved_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
    INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
    SELECT u.id, 'action_request.decided', NEW.id, 'action_item:' || NEW.id::text || ':decided'
    FROM app_user u
    WHERE u.id = NEW.created_by_user_id AND u.status = 'active'
      AND u.account_type IN ('personal', 'test')
    ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER action_item_decided_notification
  AFTER UPDATE ON action_item
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status = 'resolved')
  EXECUTE FUNCTION action_item_decided_notification();

-- Upgrade: everyone an open item waits on now gets its "opened" row (none on a fresh install).
INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key, created_at)
SELECT u.id, 'action_request.opened', a.id, 'action_item:' || a.id::text || ':opened',
       a.created_at
FROM action_item a
CROSS JOIN app_user u
WHERE a.status = 'open' AND u.status = 'active' AND u.account_type IN ('personal', 'test')
  AND action_item_routed_to(a.id, u.id)
ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING;
