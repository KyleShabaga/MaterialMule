-- MM-V2-C29: concrete notifications on the MM-T91 notification table.
--
-- A notification may now point at a concrete field report or a concrete specimen instead of an
-- action item. Everything MM-T91 built is reused unchanged: unread / read, Mark all read,
-- dismiss / restore, the 90-day list, the recipient rule (active personal or test accounts only,
-- never LAB) and one row per (recipient, event_key). In-app only (owner decision 2026-10-30): no
-- email outbox rows and no push for these kinds. Action requests and their AO07 rerouting are not
-- touched.
--
-- Concrete kinds (Combined Plan "Review interaction", "Action ownership", curing and failure):
--   concrete_report.returned        a reviewer returned a field report for correction. Written by
--                                   the API in the return command's transaction, to the
--                                   technician and the Lab Manager(s), never to the reviewer who
--                                   returned it, one row per person (C29).
--   concrete_curing.out_of_range    recorded curing temperatures outside the range (C06/C20).
--   concrete_equipment.flagged      a test or field reading used flagged equipment (C23/C14).
--   concrete_test.failed            a specimen failed its test (C23/C25).
--   concrete_report.auto_submitted  a report was submitted automatically when ready (C19).
-- Only the first has a producer now. The other four are admitted with a generic shape (one
-- concrete target, a key that starts with the kind) so their cards add a producer, and may
-- narrow the key to their source row, without reopening this table's rules.

ALTER TABLE notification
  ADD COLUMN concrete_field_report_id      uuid REFERENCES concrete_field_report (id),
  ADD COLUMN concrete_specimen_id          uuid REFERENCES concrete_specimen (id),
  -- The return event (C09 transition) a concrete_report.returned row is about: the list reads its
  -- comment and reviewer live; nothing is copied.
  ADD COLUMN concrete_report_transition_id uuid REFERENCES concrete_report_transition (id);

CREATE INDEX notification_concrete_field_report_idx
  ON notification (concrete_field_report_id) WHERE concrete_field_report_id IS NOT NULL;
CREATE INDEX notification_concrete_specimen_idx
  ON notification (concrete_specimen_id) WHERE concrete_specimen_id IS NOT NULL;
CREATE INDEX notification_concrete_report_transition_idx
  ON notification (concrete_report_transition_id) WHERE concrete_report_transition_id IS NOT NULL;

ALTER TABLE notification
  DROP CONSTRAINT notification_kind_check,
  ADD CONSTRAINT notification_kind_check CHECK (kind IN (
    'action_request.opened', 'action_request.decided',
    'concrete_report.returned', 'concrete_curing.out_of_range', 'concrete_equipment.flagged',
    'concrete_test.failed', 'concrete_report.auto_submitted')),
  DROP CONSTRAINT notification_shape_check,
  ADD CONSTRAINT notification_shape_check CHECK (
    CASE kind
      WHEN 'action_request.opened' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':opened'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id) = 0
      WHEN 'action_request.decided' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':decided'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id) = 0
      WHEN 'concrete_report.returned' THEN action_item_id IS NULL
        AND concrete_field_report_id IS NOT NULL AND concrete_specimen_id IS NULL
        AND concrete_report_transition_id IS NOT NULL
        AND event_key = 'concrete_report_transition:' || concrete_report_transition_id::text
                        || ':returned'
      WHEN 'concrete_curing.out_of_range' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_equipment.flagged' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_test.failed' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_report.auto_submitted' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      ELSE false
    END
  );

-- A returned notice names a real return of that report.
CREATE FUNCTION notification_concrete_return_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A missing transition is left to notification_shape_check.
  IF NEW.kind = 'concrete_report.returned' AND NEW.concrete_report_transition_id IS NOT NULL
     AND NOT EXISTS (
    SELECT 1 FROM concrete_report_transition t
    WHERE t.id = NEW.concrete_report_transition_id AND t.action = 'return'
      AND t.field_report_id = NEW.concrete_field_report_id
  ) THEN
    RAISE EXCEPTION 'a returned-report notification must name a return of that report'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_concrete_return_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_concrete_return_check
  BEFORE INSERT ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_concrete_return_check();

-- MM-T91's guard, now also freezing the concrete targets: only the read state changes.
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

-- No upgrade rows: returns recorded before this migration (none in production) get no notice.
