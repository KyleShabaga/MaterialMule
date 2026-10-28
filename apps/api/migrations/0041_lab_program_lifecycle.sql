-- MM-T26 (part 1): program closure and reopening, test cancellation, linked repeat tests, and
-- cancellation / closure requests.
--
-- Program lifecycle: draft → submitted (shown as Open) ⇄ closed. Closing needs the project's
-- PM/PE, at least one test request (an empty program is never closable: no vacuous truth) and
-- every request Accepted or Cancelled with a recorded reason. Reopening (PM/PE or Lab Manager,
-- reason required) changes only the program's status: no test status, acceptance or snapshot
-- changes. Every close and reopen is an append-only program_lifecycle_event; the program row keeps
-- only the current closure. Closure never touches storage units, retention, holds or disposal.
--
-- Cancellation: a test that is Requested, In progress, Completed or In review becomes Cancelled
-- with a required reason, actor and time (PM/PE of the project or Lab Manager). Cancelled
-- resolves the test for closure but is never acceptance. Cancelling an Accepted test is not
-- enabled (the card leaves that edge unresolved), nor is restoring a cancelled test.
--
-- Repeat: a new request on the same line and test, linked to an Accepted original
-- (repeat_of_id). The original keeps its status and history; the repeat starts Requested with
-- its own history and blocks closure until resolved.
--
-- Requests: a cancellation request (on a test) or closure request (on a program) is an
-- action_item for the people who can decide; the test or program is unchanged until an
-- authorised decision, which resolves the item.

-- ---------------------------------------------------------------------------------------------
-- Program closure / reopening
-- ---------------------------------------------------------------------------------------------

ALTER TABLE lab_program
  ADD COLUMN closed_at                    timestamptz,
  ADD COLUMN closed_by_user_id            uuid REFERENCES app_user (id),
  ADD COLUMN closed_by_initials_snapshot  text,
  ADD COLUMN closed_by_name_snapshot      text,
  ADD CONSTRAINT lab_program_closed_shape_check CHECK (
    (status = 'closed' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
     AND closed_by_name_snapshot IS NOT NULL)
    OR (status <> 'closed' AND closed_at IS NULL AND closed_by_user_id IS NULL
        AND closed_by_initials_snapshot IS NULL AND closed_by_name_snapshot IS NULL)
  );

CREATE TABLE program_lifecycle_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid NOT NULL REFERENCES lab_program (id),
  kind               text NOT NULL CHECK (kind IN ('closed', 'reopened')),
  -- Required to reopen; closing records none.
  reason             text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot  text,
  name_snapshot      text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT program_lifecycle_event_reason_kind_check CHECK ((kind = 'reopened') = (reason IS NOT NULL))
);
CREATE INDEX program_lifecycle_event_program_idx
  ON program_lifecycle_event (program_id, occurred_at);

CREATE TRIGGER program_lifecycle_event_append_only
  BEFORE UPDATE OR DELETE ON program_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Closing needs at least one request and every request resolved (Accepted, or Cancelled with a
-- reason). Checked here as well as in the service, which locks the program and its requests first.
CREATE FUNCTION lab_program_closure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total integer;
  unresolved integer;
BEGIN
  -- A draft is refused by lab_program_guard (restrict_violation); this checks open programs.
  IF NEW.status = 'closed' AND OLD.status = 'submitted' THEN
    SELECT count(*),
           count(*) FILTER (WHERE NOT (status = 'accepted'
                                       OR (status = 'cancelled' AND cancel_reason IS NOT NULL)))
      INTO total, unresolved
      FROM test_request WHERE program_id = NEW.id;
    IF total = 0 THEN
      RAISE EXCEPTION 'program % has no test requests and can''t be closed', NEW.program_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_closure';
    END IF;
    IF unresolved > 0 THEN
      RAISE EXCEPTION 'program % has % unresolved test request(s)', NEW.program_number, unresolved
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_closure';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_program_closure_guard
  BEFORE UPDATE OF status ON lab_program
  FOR EACH ROW EXECUTE FUNCTION lab_program_closure_guard();

-- ---------------------------------------------------------------------------------------------
-- Cancellation and repeats on test_request
-- ---------------------------------------------------------------------------------------------

ALTER TABLE test_request DROP CONSTRAINT test_request_status_check;
ALTER TABLE test_request
  ADD CONSTRAINT test_request_status_check
    CHECK (status IN ('requested', 'in_progress', 'completed', 'review', 'accepted', 'cancelled')),
  ADD COLUMN cancel_reason                  text CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 2000),
  ADD COLUMN cancelled_at                   timestamptz,
  ADD COLUMN cancelled_by_user_id           uuid REFERENCES app_user (id),
  ADD COLUMN cancelled_by_initials_snapshot text,
  ADD COLUMN cancelled_by_name_snapshot     text,
  -- A genuine repeat: the original it repeats (same program and line).
  ADD COLUMN repeat_of_id                   uuid REFERENCES test_request (id),
  -- Requests made after submission (repeats; amendments in 0042) record who made them and the
  -- retry key, so an exact retry returns the same request.
  ADD COLUMN created_by_user_id             uuid REFERENCES app_user (id),
  ADD COLUMN created_by_name_snapshot       text,
  ADD COLUMN create_idempotency_key         uuid UNIQUE,
  ADD COLUMN create_request_hash            text,
  ADD CONSTRAINT test_request_cancelled_shape_check CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
     AND cancelled_by_name_snapshot IS NOT NULL AND cancel_reason IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
        AND cancelled_by_initials_snapshot IS NULL AND cancelled_by_name_snapshot IS NULL
        AND cancel_reason IS NULL)
  ),
  ADD CONSTRAINT test_request_repeat_shape_check CHECK (
    repeat_of_id IS NULL
    OR (created_by_user_id IS NOT NULL AND create_idempotency_key IS NOT NULL
        AND create_request_hash IS NOT NULL AND repeat_of_id <> id)
  );

-- One original request per line and test; repeats of it are linked rows.
ALTER TABLE test_request DROP CONSTRAINT test_request_line_test_key;
CREATE UNIQUE INDEX test_request_line_test_key
  ON test_request (line_id, test_type_id) WHERE repeat_of_id IS NULL;
CREATE INDEX test_request_repeat_of_idx ON test_request (repeat_of_id) WHERE repeat_of_id IS NOT NULL;

ALTER TABLE test_request_status_history
  DROP CONSTRAINT test_request_status_history_transition_check;
ALTER TABLE test_request_status_history
  ADD CONSTRAINT test_request_status_history_transition_check CHECK (
    (from_status, to_status) IN (('requested', 'in_progress'), ('in_progress', 'completed'),
                                 ('completed', 'review'), ('review', 'accepted'),
                                 ('requested', 'cancelled'), ('in_progress', 'cancelled'),
                                 ('completed', 'cancelled'), ('review', 'cancelled'))
  );

-- Status and review sub-state change only along the shared table, only while the program is open.
CREATE OR REPLACE FUNCTION test_request_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('requested', 'in_progress'),
                                        ('in_progress', 'completed'),
                                        ('completed', 'review'),
                                        ('review', 'accepted'),
                                        ('requested', 'cancelled'),
                                        ('in_progress', 'cancelled'),
                                        ('completed', 'cancelled'),
                                        ('review', 'cancelled')) THEN
      RAISE EXCEPTION 'test request % can''t move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF NEW.status = 'accepted' AND OLD.review_state IS DISTINCT FROM 'review_complete' THEN
      RAISE EXCEPTION 'test request % can''t be accepted before its review is complete', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF NEW.status = 'review' AND NEW.review_state IS DISTINCT FROM 'awaiting_review' THEN
      RAISE EXCEPTION 'test request % enters review awaiting review', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
  ELSIF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    IF (OLD.review_state, NEW.review_state) NOT IN (('awaiting_review', 'returned'),
                                                    ('awaiting_review', 'review_complete'),
                                                    ('returned', 'correction_done'),
                                                    ('correction_done', 'returned'),
                                                    ('correction_done', 'review_complete')) THEN
      RAISE EXCEPTION 'test request % review can''t move from % to %', OLD.id,
        OLD.review_state, NEW.review_state
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.review_state IS DISTINCT FROM OLD.review_state)
     AND (SELECT status FROM lab_program WHERE id = OLD.program_id) <> 'submitted' THEN
    RAISE EXCEPTION 'tests of a program that isn''t open can''t change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Requests are created at submission, or later as a linked repeat while the program is open.
-- Their catalogue snapshots, links and creators never change; requests are never deleted.
CREATE OR REPLACE FUNCTION test_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'test requests can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO program_status FROM lab_program WHERE id = NEW.program_id;
    IF NEW.repeat_of_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted' THEN
        RAISE EXCEPTION 'a repeat needs an open program' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM test_request o
                     WHERE o.id = NEW.repeat_of_id AND o.program_id = NEW.program_id
                       AND o.line_id = NEW.line_id AND o.test_type_id = NEW.test_type_id) THEN
        RAISE EXCEPTION 'a repeat must link to a request of the same line and test'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
      IF NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'a repeat starts Requested'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
    ELSIF program_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'test requests are created when the program is submitted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.test_type_id IS DISTINCT FROM OLD.test_type_id
     OR NEW.test_code_snapshot IS DISTINCT FROM OLD.test_code_snapshot
     OR NEW.test_name_snapshot IS DISTINCT FROM OLD.test_name_snapshot
     OR NEW.test_description_snapshot IS DISTINCT FROM OLD.test_description_snapshot
     OR NEW.test_group_snapshot IS DISTINCT FROM OLD.test_group_snapshot
     OR NEW.test_subgroup_snapshot IS DISTINCT FROM OLD.test_subgroup_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.repeat_of_id IS DISTINCT FROM OLD.repeat_of_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key THEN
    RAISE EXCEPTION 'test request % snapshot is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Action items: cancellation and closure requests
-- ---------------------------------------------------------------------------------------------

ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item DROP CONSTRAINT action_item_target_role_check;
ALTER TABLE action_item DROP CONSTRAINT action_item_entity_type_check;
ALTER TABLE action_item
  ALTER COLUMN opened_by_event_id DROP NOT NULL,
  ADD CONSTRAINT action_item_kind_check
    CHECK (kind IN ('correction', 'cancellation_request', 'closure_request')),
  ADD CONSTRAINT action_item_target_role_check CHECK (target_role IN ('lab_manager')),
  ADD CONSTRAINT action_item_entity_type_check
    CHECK (entity_type IN ('test_request', 'lab_program')),
  -- Requests carry the requester's reason, their name and the retry key.
  ADD COLUMN reason                 text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  ADD COLUMN created_by_initials_snapshot text,
  ADD COLUMN created_by_name_snapshot     text,
  ADD COLUMN idempotency_key        uuid UNIQUE,
  ADD COLUMN request_hash           text,
  -- How it was resolved: the correction was done, the test cancelled, or the program closed.
  ADD COLUMN resolution             text
    CHECK (resolution IN ('correction_done', 'cancelled', 'closed')),
  ADD CONSTRAINT action_item_shape_check CHECK (
    CASE kind
      WHEN 'correction' THEN entity_type = 'test_request' AND opened_by_event_id IS NOT NULL
      WHEN 'cancellation_request' THEN entity_type = 'test_request' AND reason IS NOT NULL
        AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
      WHEN 'closure_request' THEN entity_type = 'lab_program' AND entity_id = program_id
        AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
    END
  ),
  ADD CONSTRAINT action_item_resolution_kind_check CHECK (
    resolution IS NULL OR status = 'resolved'
  );
-- One outstanding cancellation request per test and closure request per program.
CREATE UNIQUE INDEX action_item_open_request_key
  ON action_item (kind, entity_id) WHERE kind <> 'correction' AND status = 'open';

CREATE OR REPLACE FUNCTION action_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action items can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open' OR NEW.status <> 'resolved'
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_role IS DISTINCT FROM OLD.target_role
     OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
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
  RETURN NEW;
END;
$$;
