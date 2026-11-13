-- STRATA-104 / STRATA-118 (Kyle 2026-11-12): feedback "arrives in the administrators' Inbox as a
-- Feedback item with the page they came from". Administrator Feedback stays private.
--
-- Feedback is still an append-only audit event (`feedback.submitted`); nothing is emailed or sent
-- off the host. Each accepted submission now also writes one in-app notification per active
-- administrator (kind `feedback.submitted`), on the MM-T91 notification table with every rule it
-- already has: unread / read, dismiss / restore, the 90-day list, active personal or test
-- recipients only (never LAB), one row per (recipient, event_key).
--
-- The notice names its audit event (feedback_event_id); the Inbox reads the kind and page from
-- that event live, never a copy, and never the text (the Help & Feedback list shows it, behind
-- `feedback.read`). Only an administrator may receive one: the database refuses anyone else.
--
-- Replays: a submission may carry a client `submissionId`. One person's submissions are unique on
-- it, so a retried POST finds the first event instead of writing a second.

ALTER TABLE notification
  -- No foreign key: audit_event is append-only and refuses TRUNCATE itself (a key would turn
  -- that refusal into a different error); notification_feedback_check proves the event exists.
  ADD COLUMN feedback_event_id uuid;

CREATE INDEX notification_feedback_event_idx
  ON notification (feedback_event_id) WHERE feedback_event_id IS NOT NULL;

ALTER TABLE notification
  DROP CONSTRAINT notification_kind_check,
  ADD CONSTRAINT notification_kind_check CHECK (kind IN (
    'action_request.opened', 'action_request.decided',
    'concrete_report.returned', 'concrete_curing.out_of_range', 'concrete_equipment.flagged',
    'concrete_test.failed', 'concrete_report.auto_submitted',
    'feedback.submitted')),
  DROP CONSTRAINT notification_shape_check,
  ADD CONSTRAINT notification_shape_check CHECK (
    CASE kind
      WHEN 'action_request.opened' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':opened'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, feedback_event_id) = 0
      WHEN 'action_request.decided' THEN action_item_id IS NOT NULL
        AND event_key = 'action_item:' || action_item_id::text || ':decided'
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id, feedback_event_id) = 0
      WHEN 'concrete_report.returned' THEN action_item_id IS NULL
        AND concrete_field_report_id IS NOT NULL AND concrete_specimen_id IS NULL
        AND concrete_report_transition_id IS NOT NULL AND feedback_event_id IS NULL
        AND event_key = 'concrete_report_transition:' || concrete_report_transition_id::text
                        || ':returned'
      WHEN 'concrete_curing.out_of_range' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_equipment.flagged' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_test.failed' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'concrete_report.auto_submitted' THEN action_item_id IS NULL
        AND concrete_report_transition_id IS NULL AND feedback_event_id IS NULL
        AND num_nonnulls(concrete_field_report_id, concrete_specimen_id) = 1
        AND starts_with(event_key, kind || ':') AND length(event_key) > length(kind) + 1
      WHEN 'feedback.submitted' THEN feedback_event_id IS NOT NULL
        AND num_nonnulls(action_item_id, concrete_field_report_id, concrete_specimen_id,
                         concrete_report_transition_id) = 0
        AND event_key = 'audit_event:' || feedback_event_id::text || ':feedback'
      ELSE false
    END
  );

-- A feedback notice names a real feedback submission, and goes to an administrator only
-- (Administrator Feedback stays private; the recipient rule already refuses LAB and inactive
-- accounts).
CREATE FUNCTION notification_feedback_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'feedback.submitted' THEN
    IF NOT EXISTS (
      SELECT 1 FROM audit_event a
      WHERE a.id = NEW.feedback_event_id AND a.action = 'feedback.submitted'
    ) THEN
      RAISE EXCEPTION 'a feedback notification must name a feedback submission'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_feedback_check';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM role_assignment r
      WHERE r.user_id = NEW.recipient_user_id AND r.role = 'admin'
    ) THEN
      RAISE EXCEPTION 'feedback notifications go to administrators only'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_feedback_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_feedback_check
  BEFORE INSERT ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_feedback_check();

-- The guard, now also freezing the feedback target: only the read state changes.
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

-- One person's feedback is unique on its client submission id (a replayed POST finds the first).
CREATE UNIQUE INDEX audit_event_feedback_submission_idx
  ON audit_event (actor_user_id, (after_values ->> 'submissionId'))
  WHERE action = 'feedback.submitted' AND after_values ? 'submissionId';

-- No upgrade rows: feedback sent before this migration gets no notice.
