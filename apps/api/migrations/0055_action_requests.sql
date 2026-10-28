-- MM-T27: action requests (in-app inbox), reassignment, notification preferences and a durable
-- email outbox.
--
-- Routing (derived from real workflow policy, never from who is selected at a LAB station):
--   correction            → every Lab Manager (role-routed, shared)
--   cancellation_request  → every Lab Manager and the project's current PM/PE (shared)
--   closure_request       → the project's current PM/PE
-- A Lab Manager or admin may reassign an open item to one eligible person with a reason; the
-- item then goes to that person only. Every reassignment is an append-only row plus an audit
-- event. Resolution still happens only through the underlying workflow action (correction done,
-- test cancelled, program closed), which resolves the one shared item for everyone.
--
-- Email: people opt in (default off). Creating or reassigning an item writes one outbox row per
-- opted-in recipient; (action_item_id, recipient_user_id) is unique so retries never add a second.
-- Sending is behind EMAIL_ENABLED (refused until IT approves the sending configuration); tests
-- assert outbox rows and never send.

-- ---------------------------------------------------------------------------------------------
-- action_item: project, assignment
-- ---------------------------------------------------------------------------------------------

ALTER TABLE action_item
  ADD COLUMN project_id        uuid REFERENCES project (id),
  ADD COLUMN assigned_user_id  uuid REFERENCES app_user (id),
  ADD COLUMN assigned_at       timestamptz,
  ADD CONSTRAINT action_item_assignment_shape_check CHECK (
    (assigned_user_id IS NULL) = (assigned_at IS NULL)
  );

UPDATE action_item a SET project_id = lp.project_id
FROM lab_program lp WHERE lp.id = a.program_id AND a.project_id IS NULL;

ALTER TABLE action_item ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX action_item_project_idx ON action_item (project_id, status);
CREATE INDEX action_item_assigned_idx ON action_item (assigned_user_id) WHERE status = 'open';

-- Producers name the program; the project follows from it, so the two can never disagree.
CREATE FUNCTION action_item_fill_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_project uuid;
BEGIN
  IF NEW.program_id IS NOT NULL THEN
    SELECT project_id INTO program_project FROM lab_program WHERE id = NEW.program_id;
    IF NEW.project_id IS NULL THEN
      NEW.project_id := program_project;
    ELSIF NEW.project_id <> program_project THEN
      RAISE EXCEPTION 'action item project doesn''t match its program'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'action_item_project_matches_program';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER action_item_fill_project
  BEFORE INSERT ON action_item
  FOR EACH ROW EXECUTE FUNCTION action_item_fill_project();

-- An item is resolved once; while open, only its assignment may change (through reassignment).
CREATE OR REPLACE FUNCTION action_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action items can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open'
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_role IS DISTINCT FROM OLD.target_role
     OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.opened_by_event_id IS DISTINCT FROM OLD.opened_by_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by_name_snapshot IS DISTINCT FROM OLD.created_by_name_snapshot
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'action item % can only be resolved once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'resolved' THEN
    IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'action item % can''t be reassigned while it is resolved', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status = 'open' THEN
    -- Reassignment: a new assignee, never cleared.
    IF NEW.assigned_user_id IS NULL OR (NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id
                                        AND NEW.assigned_at IS NOT DISTINCT FROM OLD.assigned_at) THEN
      RAISE EXCEPTION 'action item % can only be resolved once', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Reassignment history (append-only). The item row keeps only the current assignee.
CREATE TABLE action_item_assignment (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_item_id              uuid NOT NULL REFERENCES action_item (id),
  from_user_id                uuid REFERENCES app_user (id),
  to_user_id                  uuid NOT NULL REFERENCES app_user (id),
  to_name_snapshot            text NOT NULL,
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  assigned_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  assigned_by_initials_snapshot text,
  assigned_by_name_snapshot   text NOT NULL,
  assigned_at                 timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL
);
CREATE INDEX action_item_assignment_item_idx ON action_item_assignment (action_item_id, assigned_at);

CREATE TRIGGER action_item_assignment_append_only
  BEFORE UPDATE OR DELETE ON action_item_assignment
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Kinds whose decision belongs to the project's PM/PE (resolved at read time, so a PM/PE change
-- on the project moves open requests to the new PM/PE).
CREATE FUNCTION action_item_routes_to_pm_pe(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request')
$$;

-- True when the item is in `uid`'s inbox: its assignee, or (unassigned) a holder of its target
-- role or the project's current PM/PE for PM/PE-routed kinds. Account status/type is checked by
-- the caller; LAB never has an inbox.
CREATE FUNCTION action_item_routed_to(item_id uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN a.assigned_user_id IS NOT NULL THEN a.assigned_user_id = uid
    ELSE (a.target_role = 'lab_manager'
          AND EXISTS (SELECT 1 FROM role_assignment r WHERE r.user_id = uid AND r.role = 'lab_manager'))
      OR (action_item_routes_to_pm_pe(a.kind) AND p.pm_pe_user_id = uid)
      OR (NOT action_item_routes_to_pm_pe(a.kind) AND a.target_user_id = uid)
  END
  FROM action_item a JOIN project p ON p.id = a.project_id
  WHERE a.id = item_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Notification preferences (personal; email for action requests, default off)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE notification_preference (
  user_id                 uuid PRIMARY KEY REFERENCES app_user (id),
  email_action_requests   boolean NOT NULL DEFAULT false,
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Email outbox
-- ---------------------------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_item_id      uuid NOT NULL REFERENCES action_item (id),
  recipient_user_id   uuid NOT NULL REFERENCES app_user (id),
  to_address          text NOT NULL CHECK (length(to_address) BETWEEN 3 AND 320),
  subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  -- pending → sent | failed (attempts exhausted) | skipped (item resolved before sending).
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text CHECK (length(last_error) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  CONSTRAINT email_outbox_one_per_recipient UNIQUE (action_item_id, recipient_user_id),
  CONSTRAINT email_outbox_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
