-- STRATA-133 (Kyle 2026-11-16): "hold released" notices. A deliberate exception to the
-- 2026-10-31 rule against routine-event notices in V1, for this one kind only.
--
-- When a retention hold is released, the person it was for gets one in-app notification (kind
-- `retention_hold.released`):
--   * the person who asked for it, when the hold came from an approved retention request;
--   * otherwise the person who placed it.
-- Never the person doing the release (no notice about your own action), and only an active
-- personal or test account (the MM-T91 recipient rule: never LAB, never a disabled account).
-- Holds are placed, requested and released by personal accounts only, so a LAB station's
-- "acting as" person never becomes a recipient through anyone's roles.
--
-- Written by a trigger on the hold's one-time release (released_at null → a time), in the same
-- transaction as the release: every release path is covered, and two concurrent releases (one
-- waits on the row lock, then finds it released) write one row. The unique (recipient,
-- event_key) key is a second guard. Retention extensions get no notice.
--
-- The notice names its hold (retention_hold_id); the Inbox reads the units, project, releaser
-- and reason from the hold live, never a copy. No upgrade rows: holds released before this
-- migration get no notice.

ALTER TABLE notification ADD COLUMN retention_hold_id uuid REFERENCES retention_hold (id);

CREATE INDEX notification_retention_hold_idx
  ON notification (retention_hold_id) WHERE retention_hold_id IS NOT NULL;

ALTER TABLE notification
  DROP CONSTRAINT notification_kind_check,
  ADD CONSTRAINT notification_kind_check CHECK (kind IN (
    'action_request.opened', 'action_request.decided',
    'concrete_report.returned', 'concrete_curing.out_of_range', 'concrete_equipment.flagged',
    'concrete_test.failed', 'concrete_report.auto_submitted',
    'feedback.submitted',
    'retention_hold.released')),
  DROP CONSTRAINT notification_shape_check,
  ADD CONSTRAINT notification_shape_check CHECK (
    CASE kind
      WHEN 'action_request.opened' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':opened'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, feedback_event_id,
                         retention_hold_id) = 0
      WHEN 'action_request.decided' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':decided'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, feedback_event_id,
                         retention_hold_id) = 0
      WHEN 'concrete_report.returned' THEN action_item_id IS NULL
        AND concrete_field_report_id IS NOT NULL AND concrete_specimen_id IS NULL
        AND concrete_report_transition_id IS NOT NULL AND feedback_event_id IS NULL
        AND retention_hold_id IS NULL
        AND event_key = 'concrete_report_transition:' || concrete_report_transition_id::text
                        || ':returned'
      WHEN 'concrete_curing.out_of_range' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND retention_hold_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_equipment.flagged' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND retention_hold_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_test.failed' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND retention_hold_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_report.auto_submitted' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND retention_hold_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'feedback.submitted' THEN feedback_event_id IS NOT NULL
        AND num_nonnulls(action_item_id, concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, retention_hold_id) = 0
        AND event_key = 'audit_event:' || feedback_event_id::text || ':feedback'
      WHEN 'retention_hold.released' THEN retention_hold_id IS NOT NULL
        AND num_nonnulls(action_item_id, concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, feedback_event_id) = 0
        AND event_key = 'retention_hold:' || retention_hold_id::text || ':released'
      ELSE false
    END
  );

-- Who a hold's release notifies: the requester when it came from a request, else the placer.
CREATE FUNCTION retention_hold_notice_recipient(hold retention_hold) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT r.requested_by_user_id FROM retention_request r WHERE r.id = hold.request_id),
    hold.placed_by_user_id);
$$;

-- A hold-released notice names a released hold and goes to that hold's one recipient, never to
-- the person who released it. Anyone else is refused, whatever writes the row.
CREATE FUNCTION notification_retention_hold_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  hold retention_hold;
BEGIN
  IF NEW.kind = 'retention_hold.released' THEN
    SELECT * INTO hold FROM retention_hold WHERE id = NEW.retention_hold_id;
    IF hold.id IS NULL OR hold.released_at IS NULL THEN
      RAISE EXCEPTION 'a hold-released notification must name a released hold'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_retention_hold_check';
    END IF;
    IF NEW.recipient_user_id IS DISTINCT FROM retention_hold_notice_recipient(hold)
       OR NEW.recipient_user_id = hold.released_by_user_id THEN
      RAISE EXCEPTION 'a hold-released notification goes to the person the hold was for'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_retention_hold_check';
    END IF;
  ELSIF NEW.retention_hold_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a hold-released notification names a hold'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_retention_hold_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_retention_hold_check
  BEFORE INSERT ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_retention_hold_check();

-- The notice, once, when the hold's release is recorded. retention_hold's own rules let
-- released_at go from null to a time once, so this fires once per hold.
CREATE FUNCTION retention_hold_released_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recipient uuid;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    recipient := retention_hold_notice_recipient(NEW);
    IF recipient IS DISTINCT FROM NEW.released_by_user_id THEN
      INSERT INTO notification (recipient_user_id, kind, retention_hold_id, event_key)
      SELECT u.id, 'retention_hold.released', NEW.id,
             'retention_hold:' || NEW.id::text || ':released'
      FROM app_user u
      WHERE u.id = recipient AND u.status = 'active' AND u.account_type IN ('personal', 'test')
      ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER retention_hold_released_notification
  AFTER UPDATE OF released_at ON retention_hold
  FOR EACH ROW EXECUTE FUNCTION retention_hold_released_notification();

-- The guard, now also freezing the hold: only the read state changes.
CREATE OR REPLACE FUNCTION notification_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'notifications can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.action_item_id IS DISTINCT FROM OLD.action_item_id
     OR NEW.concrete_field_report_id IS DISTINCT FROM OLD.concrete_field_report_id
     OR NEW.concrete_specimen_id IS DISTINCT FROM OLD.concrete_specimen_id
     OR NEW.concrete_report_transition_id IS DISTINCT FROM OLD.concrete_report_transition_id
     OR NEW.feedback_event_id IS DISTINCT FROM OLD.feedback_event_id
     OR NEW.retention_hold_id IS DISTINCT FROM OLD.retention_hold_id
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
