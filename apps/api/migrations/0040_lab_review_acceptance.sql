-- MM-T25: review decisions, corrections returned to the Lab Manager, acceptance by the project's
-- Lead Project Engineer or an active acceptance delegate, and per-project acceptance delegation.
--
-- Test progress gains one stage: review → accepted. Review keeps its own sub-state
-- (test_request.review_state) while the test is in Review, which is not a new progress stage:
--   awaiting_review → returned (return for correction, comment required)
--   awaiting_review → review_complete
--   returned → correction_done (Lab Manager, note required; acceptance still blocked)
--   correction_done → returned (a new correction cycle) or → review_complete (fresh review)
--   review_complete → accepted (status changes to accepted; review_state is cleared)
-- Returning never moves a test back to In progress. Review complete → Returned is deliberately not
-- allowed: the card leaves that reverse edge unresolved (Notion MM-T25 §12 B), so it stays refused
-- until the owner decides. Cancellation, repeats, accepted-request changes and closure are MM-T26.
--
-- Every decision is an append-only test_request_review_event with the authenticated personal
-- account (review and acceptance are never LAB actions, so the account is the person), its retry
-- key and intent hash. A return opens one action_item for the Lab Manager role; marking the
-- correction done resolves exactly that item. Acceptance records who accepted and, when they did
-- so as a delegate, the delegation used, so a later revocation never rewrites the attribution.

-- ---------------------------------------------------------------------------------------------
-- Acceptance delegation (D04): granted and revoked by the project's Lead Project Engineer; history kept
-- ---------------------------------------------------------------------------------------------

CREATE TABLE acceptance_delegation (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                   uuid NOT NULL REFERENCES project (id),
  delegate_user_id             uuid NOT NULL REFERENCES app_user (id),
  delegate_initials_snapshot   text,
  delegate_name_snapshot       text NOT NULL,
  granted_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot text,
  granted_by_name_snapshot     text NOT NULL,
  granted_at                   timestamptz NOT NULL DEFAULT now(),
  grant_idempotency_key        uuid NOT NULL UNIQUE,
  grant_request_hash           text NOT NULL,
  revoked_by_user_id           uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot text,
  revoked_by_name_snapshot     text,
  revoked_at                   timestamptz,
  CONSTRAINT acceptance_delegation_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoked_at >= granted_at)
  )
);
-- At most one active grant per project and person; repeated grants can't stack.
CREATE UNIQUE INDEX acceptance_delegation_active_key
  ON acceptance_delegation (project_id, delegate_user_id) WHERE revoked_at IS NULL;
CREATE INDEX acceptance_delegation_project_idx ON acceptance_delegation (project_id, granted_at);

-- A grant is never deleted; the only change it ever takes is its one revocation.
CREATE FUNCTION acceptance_delegation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'acceptance delegations can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'acceptance delegation % is already revoked', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.delegate_user_id IS DISTINCT FROM OLD.delegate_user_id
     OR NEW.delegate_initials_snapshot IS DISTINCT FROM OLD.delegate_initials_snapshot
     OR NEW.delegate_name_snapshot IS DISTINCT FROM OLD.delegate_name_snapshot
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.granted_by_initials_snapshot IS DISTINCT FROM OLD.granted_by_initials_snapshot
     OR NEW.granted_by_name_snapshot IS DISTINCT FROM OLD.granted_by_name_snapshot
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.grant_idempotency_key IS DISTINCT FROM OLD.grant_idempotency_key
     OR NEW.grant_request_hash IS DISTINCT FROM OLD.grant_request_hash THEN
    RAISE EXCEPTION 'acceptance delegation % grant can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_delegation_guard
  BEFORE UPDATE OR DELETE ON acceptance_delegation
  FOR EACH ROW EXECUTE FUNCTION acceptance_delegation_guard();

-- ---------------------------------------------------------------------------------------------
-- Test request: accepted stage, review sub-state, acceptance attribution
-- ---------------------------------------------------------------------------------------------

ALTER TABLE test_request DROP CONSTRAINT test_request_status_check;
ALTER TABLE test_request
  ADD CONSTRAINT test_request_status_check
    CHECK (status IN ('requested', 'in_progress', 'completed', 'review', 'accepted')),
  ADD COLUMN review_state text
    CHECK (review_state IN ('awaiting_review', 'returned', 'correction_done', 'review_complete')),
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_by_user_id uuid REFERENCES app_user (id),
  -- The grant used when the acceptor accepted as a delegate (null for the project's Lead Project Engineer).
  ADD COLUMN accepted_via_delegation_id uuid REFERENCES acceptance_delegation (id);

-- Tests already sent to review under MM-T24 are awaiting review.
UPDATE test_request SET review_state = 'awaiting_review' WHERE status = 'review';

ALTER TABLE test_request
  ADD CONSTRAINT test_request_review_state_shape_check
    CHECK ((status = 'review') = (review_state IS NOT NULL)),
  ADD CONSTRAINT test_request_accepted_shape_check CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
    OR (status <> 'accepted' AND accepted_at IS NULL AND accepted_by_user_id IS NULL
        AND accepted_via_delegation_id IS NULL)
  );

ALTER TABLE test_request_status_history
  DROP CONSTRAINT test_request_status_history_transition_check;
ALTER TABLE test_request_status_history
  ADD CONSTRAINT test_request_status_history_transition_check CHECK (
    (from_status, to_status) IN (('requested', 'in_progress'), ('in_progress', 'completed'),
                                 ('completed', 'review'), ('review', 'accepted'))
  );

-- Status and review sub-state change only along the table above, only while the program is
-- submitted (open), and acceptance needs a complete review.
CREATE OR REPLACE FUNCTION test_request_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('requested', 'in_progress'),
                                        ('in_progress', 'completed'),
                                        ('completed', 'review'),
                                        ('review', 'accepted')) THEN
      RAISE EXCEPTION 'test request % can''t move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF OLD.status = 'review' AND OLD.review_state IS DISTINCT FROM 'review_complete' THEN
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

DROP TRIGGER test_request_status_guard ON test_request;
CREATE TRIGGER test_request_status_guard
  BEFORE UPDATE OF status, review_state ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_status_guard();

-- ---------------------------------------------------------------------------------------------
-- Review decisions (append-only) and the Lab Manager's correction work items
-- ---------------------------------------------------------------------------------------------

CREATE TABLE test_request_review_event (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id       uuid NOT NULL REFERENCES test_request (id),
  program_id            uuid NOT NULL REFERENCES lab_program (id),
  kind                  text NOT NULL
                          CHECK (kind IN ('review_completed', 'returned', 'correction_done',
                                          'accepted')),
  from_review_state     text NOT NULL,
  -- Null for acceptance (the test leaves Review).
  to_review_state       text,
  -- The return comment or the correction note; required for exactly those two.
  comment               text CHECK (length(btrim(comment)) BETWEEN 1 AND 4000),
  -- The correction cycle the event belongs to (1 = first return); 0 before any return.
  correction_cycle      integer NOT NULL CHECK (correction_cycle >= 0),
  user_id               uuid NOT NULL REFERENCES app_user (id),
  account_type          text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot     text,
  name_snapshot         text NOT NULL,
  -- For acceptance by a delegate: the grant that authorised it (kept after revocation).
  delegation_id         uuid REFERENCES acceptance_delegation (id),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  idempotency_key       uuid NOT NULL UNIQUE,
  request_hash          text NOT NULL,
  CONSTRAINT test_request_review_event_comment_required_check CHECK (
    (kind IN ('returned', 'correction_done')) = (comment IS NOT NULL)
  ),
  CONSTRAINT test_request_review_event_delegation_check CHECK (
    delegation_id IS NULL OR kind = 'accepted'
  )
);
CREATE INDEX test_request_review_event_request_idx
  ON test_request_review_event (test_request_id, occurred_at);
CREATE INDEX test_request_review_event_program_idx
  ON test_request_review_event (program_id, occurred_at);

CREATE TRIGGER test_request_review_event_append_only
  BEFORE UPDATE OR DELETE ON test_request_review_event
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Minimal actionable items (MM-T25). MM-T27 turns them into notifications and email; MM-T26 adds
-- cancellation and closure requests. An item is opened once and resolved once, never deleted.
CREATE TABLE action_item (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('correction')),
  target_role           text CHECK (target_role IN ('lab_manager')),
  target_user_id        uuid REFERENCES app_user (id),
  entity_type           text NOT NULL CHECK (entity_type IN ('test_request')),
  entity_id             uuid NOT NULL,
  program_id            uuid NOT NULL REFERENCES lab_program (id),
  -- The review event that raised it (a return) and, once resolved, the one that resolved it.
  opened_by_event_id    uuid NOT NULL REFERENCES test_request_review_event (id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  resolved_at           timestamptz,
  resolved_by_user_id   uuid REFERENCES app_user (id),
  resolved_by_event_id  uuid REFERENCES test_request_review_event (id),
  CONSTRAINT action_item_target_check CHECK (target_role IS NOT NULL OR target_user_id IS NOT NULL),
  CONSTRAINT action_item_resolution_check CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolved_by_user_id IS NULL
     AND resolved_by_event_id IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  )
);
-- One outstanding correction per test.
CREATE UNIQUE INDEX action_item_open_correction_key
  ON action_item (entity_id) WHERE kind = 'correction' AND status = 'open';
CREATE INDEX action_item_open_idx ON action_item (status, target_role, created_at);
CREATE INDEX action_item_program_idx ON action_item (program_id, created_at);

CREATE FUNCTION action_item_guard() RETURNS trigger
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
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'action item % can only be resolved once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER action_item_guard
  BEFORE UPDATE OR DELETE ON action_item
  FOR EACH ROW EXECUTE FUNCTION action_item_guard();
