-- MM-T24: lab worklist, per-test progress, priority history, comments and exact tested-unit
-- evidence.
--
-- Test status path implemented here: requested → in_progress → completed → review (Awaiting
-- review). Review decisions and acceptance are MM-T25; cancellation, repeats and reopening are
-- MM-T26. One server-side transition table (apps/api/src/lab/transitions.ts) decides what may
-- happen; the database refuses anything else and refuses status changes outside a submitted
-- program.
--
-- Every status change, priority change, comment and comment edit is an append-only history row
-- carrying the authenticated account and, for a shared LAB station, the selected staff member
-- ("LAB for person"), with snapshots. Each also stores the client's retry key and a hash of its
-- intent, so an exact retry returns the original result and a different intent under the same
-- key is refused, without duplicating history.
--
-- Tested-unit evidence: a completion may link the exact physical storage units actually used
-- (validated against the line's frozen coverage). Coverage, source, receipt or group membership
-- is never treated as evidence. Completion changes no unit: physical removal after testing is
-- MM-T36's separate personal-account action, which reads this evidence.

ALTER TABLE test_request DROP CONSTRAINT test_request_status_check;
ALTER TABLE test_request
  ADD CONSTRAINT test_request_status_check
    CHECK (status IN ('requested', 'in_progress', 'completed', 'review')),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by_account_user_id uuid REFERENCES app_user (id),
  ADD COLUMN status_changed_for_user_id uuid REFERENCES app_user (id);

CREATE TABLE test_request_status_history (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id            uuid NOT NULL REFERENCES test_request (id),
  program_id                 uuid NOT NULL REFERENCES lab_program (id),
  from_status                text NOT NULL,
  to_status                  text NOT NULL,
  account_user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type               text NOT NULL CHECK (account_type IN ('personal', 'shared_lab', 'test')),
  account_initials_snapshot  text,
  account_name_snapshot      text NOT NULL,
  person_user_id             uuid NOT NULL REFERENCES app_user (id),
  person_initials_snapshot   text,
  person_name_snapshot       text NOT NULL,
  changed_at                 timestamptz NOT NULL DEFAULT now(),
  idempotency_key            uuid NOT NULL UNIQUE,
  request_hash               text NOT NULL,
  -- The only moves this card makes (MM-T25/T26 add theirs with their own migrations).
  CONSTRAINT test_request_status_history_transition_check CHECK (
    (from_status, to_status) IN (('requested', 'in_progress'), ('in_progress', 'completed'),
                                 ('completed', 'review'))
  )
);
CREATE INDEX test_request_status_history_request_idx
  ON test_request_status_history (test_request_id, changed_at);

-- Exact physical units used by a completed test (append-only evidence).
CREATE TABLE test_request_unit_link (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id     uuid NOT NULL REFERENCES test_request (id),
  -- The completion event that recorded the link (actor, person and time live there).
  status_history_id   uuid NOT NULL REFERENCES test_request_status_history (id),
  storage_unit_id     uuid NOT NULL REFERENCES storage_unit (id),
  -- The unit's project when linked; must be the program's project (checked by the service).
  project_id          uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot text NOT NULL,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_request_unit_link_key UNIQUE (test_request_id, storage_unit_id)
);
CREATE INDEX test_request_unit_link_unit_idx ON test_request_unit_link (storage_unit_id);

CREATE TABLE program_priority_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id            uuid NOT NULL REFERENCES lab_program (id),
  from_priority         text NOT NULL CHECK (from_priority IN ('normal', 'urgent')),
  to_priority           text NOT NULL CHECK (to_priority IN ('normal', 'urgent')),
  user_id               uuid NOT NULL REFERENCES app_user (id),
  initials_snapshot     text,
  name_snapshot         text NOT NULL,
  changed_at            timestamptz NOT NULL DEFAULT now(),
  idempotency_key       uuid NOT NULL UNIQUE,
  request_hash          text NOT NULL,
  CHECK (from_priority <> to_priority)
);
CREATE INDEX program_priority_history_program_idx ON program_priority_history (program_id, changed_at);

CREATE TABLE lab_comment (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                        uuid NOT NULL REFERENCES lab_program (id),
  -- Null for a comment on the whole program.
  line_id                           uuid,
  author_account_user_id            uuid NOT NULL REFERENCES app_user (id),
  author_account_type               text NOT NULL
                                      CHECK (author_account_type IN ('personal', 'shared_lab', 'test')),
  author_account_name_snapshot      text NOT NULL,
  -- The person who wrote it: the account's own person, or the LAB station's selected person.
  author_person_user_id             uuid NOT NULL REFERENCES app_user (id),
  author_person_initials_snapshot   text,
  author_person_name_snapshot       text NOT NULL,
  body                              text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  edited_at                         timestamptz,
  version                           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_key                   uuid NOT NULL UNIQUE,
  request_hash                      text NOT NULL,
  CONSTRAINT lab_comment_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id)
);
CREATE INDEX lab_comment_program_idx ON lab_comment (program_id, line_id, created_at);

-- Every text a comment has had, in order: revision 1 is the original.
CREATE TABLE lab_comment_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id         uuid NOT NULL REFERENCES lab_comment (id),
  revision_number    integer NOT NULL CHECK (revision_number >= 1),
  body               text NOT NULL,
  account_user_id    uuid NOT NULL REFERENCES app_user (id),
  person_user_id     uuid NOT NULL REFERENCES app_user (id),
  person_initials_snapshot text,
  person_name_snapshot     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT lab_comment_revision_key UNIQUE (comment_id, revision_number)
);

-- History, evidence, comments and revisions are append-only; comments are never deleted (their
-- text changes only by an edit, which adds a revision).
CREATE FUNCTION lab_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be changed or removed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER test_request_status_history_append_only
  BEFORE UPDATE OR DELETE ON test_request_status_history
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER test_request_unit_link_append_only
  BEFORE UPDATE OR DELETE ON test_request_unit_link
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER program_priority_history_append_only
  BEFORE UPDATE OR DELETE ON program_priority_history
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER lab_comment_revision_append_only
  BEFORE UPDATE OR DELETE ON lab_comment_revision
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

CREATE FUNCTION lab_comment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'comments can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.author_account_user_id IS DISTINCT FROM OLD.author_account_user_id
     OR NEW.author_person_user_id IS DISTINCT FROM OLD.author_person_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'comment % authorship can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_comment_guard
  BEFORE UPDATE OR DELETE ON lab_comment
  FOR EACH ROW EXECUTE FUNCTION lab_comment_guard();

-- Status changes only along the path and only while the program is submitted (a draft has no
-- requests; a closed program is not workable).
CREATE FUNCTION test_request_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('requested', 'in_progress'),
                                        ('in_progress', 'completed'),
                                        ('completed', 'review')) THEN
      RAISE EXCEPTION 'test request % can''t move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF (SELECT status FROM lab_program WHERE id = OLD.program_id) <> 'submitted' THEN
      RAISE EXCEPTION 'tests of a program that isn''t open can''t change'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_status_guard
  BEFORE UPDATE OF status ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_status_guard();

-- Worklist: open programs by priority then submission (D52).
CREATE INDEX lab_program_worklist_idx ON lab_program ((priority = 'urgent') DESC, submitted_at, id)
  WHERE status = 'submitted';
CREATE INDEX test_request_status_idx ON test_request (program_id, status);
