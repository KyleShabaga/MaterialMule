-- MM-T26 (part 2): amendments to an open program and changes to an accepted test.
--
-- Amendment (D02): an explicit, recorded change to a submitted, open program: new testing lines,
-- new tests on an existing line, or later receipts included in an ALL / Grabs / SPT line from an
-- explicitly reviewed list of units. Every amendment is one append-only program_amendment row
-- listing what it added (including the added units' readable IDs). Rows it adds carry its ID; the
-- coverage frozen at submission is never changed or removed, and a later receipt alone never
-- extends a line.
--
-- Accepted-request change (D09): changing the sample, depth or requested test of an Accepted
-- request resets only that request to Requested, clears its current review and acceptance and
-- needs a fresh review and acceptance. Each change is an append-only identity revision with the
-- before/after values and reason; earlier review events keep the historical acceptance. A
-- request's sample/depth may differ from its line's (the line is shared with its other tests), so
-- the request keeps its own current identity in override columns.

CREATE TABLE program_amendment (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id               uuid NOT NULL REFERENCES lab_program (id),
  amendment_number         integer NOT NULL CHECK (amendment_number >= 1),
  reason                   text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  -- What it added, as recorded at the time (lines, tests, units with readable IDs).
  details                  jsonb NOT NULL,
  added_unit_readable_ids  text[] NOT NULL DEFAULT '{}',
  user_id                  uuid NOT NULL REFERENCES app_user (id),
  account_type             text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot        text,
  name_snapshot            text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  idempotency_key          uuid NOT NULL UNIQUE,
  request_hash             text NOT NULL,
  CONSTRAINT program_amendment_number_key UNIQUE (program_id, amendment_number)
);

CREATE TRIGGER program_amendment_append_only
  BEFORE UPDATE OR DELETE ON program_amendment
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

ALTER TABLE test_line ADD COLUMN amendment_id uuid REFERENCES program_amendment (id);
ALTER TABLE test_request ADD COLUMN amendment_id uuid REFERENCES program_amendment (id);
ALTER TABLE program_scope_snapshot ADD COLUMN amendment_id uuid REFERENCES program_amendment (id);

-- An amendment's rows belong to the amendment's program.
CREATE FUNCTION lab_amendment_program_matches(amendment uuid, program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM program_amendment WHERE id = amendment AND program_id = program)
$$;

CREATE FUNCTION lab_program_is_open(program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT status = 'submitted' FROM lab_program WHERE id = program
$$;

-- Lines change only while their program is a draft, except that an amendment may add a complete
-- line (source and frozen display/capture set) to an open program. Amended lines never change.
CREATE OR REPLACE FUNCTION test_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program uuid;
BEGIN
  program := CASE WHEN TG_OP = 'DELETE' THEN OLD.program_id ELSE NEW.program_id END;
  IF TG_OP = 'INSERT' AND NEW.amendment_id IS NOT NULL THEN
    IF NOT coalesce(lab_program_is_open(program), false)
       OR NOT lab_amendment_program_matches(NEW.amendment_id, program)
       OR NEW.source_kind IS NULL OR NEW.source_display_snapshot IS NULL
       OR NEW.coverage_captured_at IS NULL THEN
      RAISE EXCEPTION 'an amendment adds a complete line to an open program only'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce(lab_program_is_draft(program), true) THEN
    RAISE EXCEPTION 'testing lines of a submitted program can''t change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Coverage is frozen at submission; an amendment may append rows (never change or remove one).
CREATE OR REPLACE FUNCTION program_scope_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'frozen coverage can''t be changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amendment_id IS NOT NULL THEN
    IF NOT coalesce(lab_program_is_open(NEW.program_id), false)
       OR NOT lab_amendment_program_matches(NEW.amendment_id, NEW.program_id) THEN
      RAISE EXCEPTION 'an amendment adds coverage to an open program only'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce(lab_program_is_draft(NEW.program_id), false) THEN
    RAISE EXCEPTION 'coverage is frozen when the program is submitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Accepted-request change: identity revisions
-- ---------------------------------------------------------------------------------------------

ALTER TABLE test_request
  ADD COLUMN identity_revision      integer NOT NULL DEFAULT 0 CHECK (identity_revision >= 0),
  -- The request's own Specific sample/depth when changed after acceptance (null: the line's).
  ADD COLUMN sample_label_override  text
    CHECK (sample_label_override = btrim(sample_label_override)
           AND length(sample_label_override) BETWEEN 1 AND 40
           AND sample_label_override !~ '[[:cntrl:]]'),
  ADD COLUMN depth_mode_override    text CHECK (depth_mode_override IN ('point', 'interval')),
  ADD COLUMN depth_from_override    numeric(8, 2) CHECK (depth_from_override >= 0),
  ADD COLUMN depth_to_override      numeric(8, 2),
  ADD COLUMN depth_unit_override    text CHECK (depth_unit_override IN ('ft', 'm')),
  ADD CONSTRAINT test_request_identity_override_check CHECK (
    (sample_label_override IS NULL AND depth_mode_override IS NULL
     AND depth_from_override IS NULL AND depth_to_override IS NULL
     AND depth_unit_override IS NULL)
    OR (sample_label_override IS NOT NULL AND depth_mode_override IS NOT NULL
        AND depth_from_override IS NOT NULL AND depth_unit_override IS NOT NULL
        AND ((depth_mode_override = 'point' AND depth_to_override IS NULL)
             OR (depth_mode_override = 'interval' AND depth_to_override IS NOT NULL
                 AND depth_to_override >= depth_from_override)))
  );

CREATE TABLE test_request_identity_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id    uuid NOT NULL REFERENCES test_request (id),
  program_id         uuid NOT NULL REFERENCES lab_program (id),
  revision_number    integer NOT NULL CHECK (revision_number >= 1),
  -- Sample, depth and test as they were and as they became (display values and IDs).
  before             jsonb NOT NULL,
  after              jsonb NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot  text,
  name_snapshot      text NOT NULL,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT test_request_identity_revision_key UNIQUE (test_request_id, revision_number)
);
CREATE INDEX test_request_identity_revision_program_idx
  ON test_request_identity_revision (program_id, changed_at);

CREATE TRIGGER test_request_identity_revision_append_only
  BEFORE UPDATE OR DELETE ON test_request_identity_revision
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- A completed test may be completed again after an accepted-request change resets it; each
-- completion keeps its own evidence. One link per completion and unit (was per request and unit).
ALTER TABLE test_request_unit_link DROP CONSTRAINT test_request_unit_link_key;
ALTER TABLE test_request_unit_link
  ADD CONSTRAINT test_request_unit_link_key UNIQUE (status_history_id, storage_unit_id);
CREATE INDEX test_request_unit_link_request_idx ON test_request_unit_link (test_request_id);

ALTER TABLE test_request_status_history
  DROP CONSTRAINT test_request_status_history_transition_check;
ALTER TABLE test_request_status_history
  ADD CONSTRAINT test_request_status_history_transition_check CHECK (
    (from_status, to_status) IN (('requested', 'in_progress'), ('in_progress', 'completed'),
                                 ('completed', 'review'), ('review', 'accepted'),
                                 ('requested', 'cancelled'), ('in_progress', 'cancelled'),
                                 ('completed', 'cancelled'), ('review', 'cancelled'),
                                 ('accepted', 'requested'))
  );

-- Status and review sub-state change only along the shared table, only while the program is open.
-- Accepted → Requested only with a new identity revision (an accepted-request change).
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
                                        ('review', 'cancelled'),
                                        ('accepted', 'requested')) THEN
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
    IF OLD.status = 'accepted' AND NEW.identity_revision <> OLD.identity_revision + 1 THEN
      RAISE EXCEPTION 'test request % returns to Requested only through an identity change', OLD.id
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
  BEFORE UPDATE OF status, review_state, identity_revision ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_status_guard();

-- Requests are created at submission, as a linked repeat or by an amendment while the program is
-- open. Snapshots, links and creators never change, except that an identity change (accepted
-- test, revision + 1, back to Requested) may replace the test snapshot and the sample/depth.
CREATE OR REPLACE FUNCTION test_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_status text;
  revising boolean;
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
    ELSIF NEW.amendment_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted'
         OR NOT lab_amendment_program_matches(NEW.amendment_id, NEW.program_id)
         OR NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'an amendment adds Requested tests to an open program only'
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF program_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'test requests are created when the program is submitted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  revising := NEW.identity_revision = OLD.identity_revision + 1
              AND OLD.status = 'accepted' AND NEW.status = 'requested';
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.repeat_of_id IS DISTINCT FROM OLD.repeat_of_id
     OR NEW.amendment_id IS DISTINCT FROM OLD.amendment_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
     OR NEW.identity_revision < OLD.identity_revision
     OR (NEW.identity_revision > OLD.identity_revision AND NOT revising)
     OR (NOT revising AND (
           NEW.test_type_id IS DISTINCT FROM OLD.test_type_id
           OR NEW.test_code_snapshot IS DISTINCT FROM OLD.test_code_snapshot
           OR NEW.test_name_snapshot IS DISTINCT FROM OLD.test_name_snapshot
           OR NEW.test_description_snapshot IS DISTINCT FROM OLD.test_description_snapshot
           OR NEW.test_group_snapshot IS DISTINCT FROM OLD.test_group_snapshot
           OR NEW.test_subgroup_snapshot IS DISTINCT FROM OLD.test_subgroup_snapshot
           OR NEW.sample_label_override IS DISTINCT FROM OLD.sample_label_override
           OR NEW.depth_mode_override IS DISTINCT FROM OLD.depth_mode_override
           OR NEW.depth_from_override IS DISTINCT FROM OLD.depth_from_override
           OR NEW.depth_to_override IS DISTINCT FROM OLD.depth_to_override
           OR NEW.depth_unit_override IS DISTINCT FROM OLD.depth_unit_override)) THEN
    RAISE EXCEPTION 'test request % snapshot is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
