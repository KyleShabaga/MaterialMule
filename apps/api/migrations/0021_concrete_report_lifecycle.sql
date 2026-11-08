-- MM-V2-C09: report versions and the review / issue lifecycle (field-report path).
--
-- The report row (concrete_field_report) stays the draft and the current state. Each submission
-- freezes a numbered version with an immutable snapshot of the report as submitted. Every command
-- (submit, recall, return, resubmit, review, issue, revise) appends one transition row and one
-- audit event in the same transaction. Combined Plan "Corrections and revisions" and section 9:
-- submitted versions are locked; the technician may recall one that is not yet reviewed, the
-- reviewer may return it with a comment; a change after review needs a fresh review (the
-- returned version's review stops counting); an issued version never changes, and corrections
-- after issue make a linked revision (a new version) while the original stays.
--
-- One model for both report types: `report_kind` takes 'field' only. Strength reports join in
-- their own migration once owner decision G2 settles what a strength report contains and how it
-- is numbered.
--
-- Lock order (D09): the report row FOR UPDATE, its open version FOR UPDATE, then the project and
-- the accounts FOR SHARE (canUnderLock), then the transition ledger.

-- Set by a save while the report is returned when the person saving holds the Lab Manager role,
-- and cleared when it is submitted again: such a correction is reviewed by the project's Lead
-- Project Engineer (D11), not by the reviewer who returned it.
ALTER TABLE concrete_field_report
  ADD COLUMN lab_manager_corrected_by_user_id uuid REFERENCES app_user (id),
  ADD CONSTRAINT concrete_field_report_lab_manager_correction_check
    CHECK (lab_manager_corrected_by_user_id IS NULL OR workflow_state = 'returned');
CREATE INDEX concrete_field_report_lm_corrected_idx
  ON concrete_field_report (lab_manager_corrected_by_user_id)
  WHERE lab_manager_corrected_by_user_id IS NOT NULL;

CREATE TABLE concrete_report_version (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind                 text NOT NULL DEFAULT 'field'
                                CONSTRAINT concrete_report_version_kind_check
                                CHECK (report_kind IN ('field')),
  project_id                  uuid NOT NULL,
  field_report_id             uuid NOT NULL,
  -- 1, 2, 3 … per report, without gaps (trigger below).
  version_no                  integer NOT NULL
                                CONSTRAINT concrete_report_version_no_check CHECK (version_no >= 1),
  -- The issued version this one corrects (an issued revision); null for an ordinary submission.
  revision_of_version_id      uuid,
  -- The report as submitted (the API's read model at that moment) and its SHA-256, set by the
  -- database from the stored jsonb text.
  snapshot                    jsonb NOT NULL
                                CONSTRAINT concrete_report_version_snapshot_check
                                CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_sha256             text NOT NULL,
  -- The report row's version the submission was based on.
  report_row_version          integer NOT NULL,
  state                       text NOT NULL DEFAULT 'submitted'
                                CONSTRAINT concrete_report_version_state_check
                                CHECK (state IN ('submitted', 'recalled', 'returned', 'reviewed', 'issued')),
  -- The signed-in account (may be LAB) and the person credited (never LAB).
  submitted_by_user_id        uuid NOT NULL REFERENCES app_user (id),
  submitted_staff_user_id     uuid NOT NULL REFERENCES app_user (id),
  submitted_at                timestamptz NOT NULL DEFAULT now(),
  -- Who reviews it: any designated reviewer (or the lead), the reviewer who returned it, or the
  -- project's Lead Project Engineer (a Lab Manager's correction, D11).
  route_kind                  text NOT NULL
                                CONSTRAINT concrete_report_version_route_kind_check
                                CHECK (route_kind IN ('designated_reviewers', 'original_reviewer',
                                                      'lead_project_engineer')),
  routed_to_user_id           uuid REFERENCES app_user (id),
  route_reason                text
                                CONSTRAINT concrete_report_version_route_reason_check
                                CHECK (route_reason IN ('resubmission', 'lab_manager_correction',
                                                        'original_reviewer_unavailable')),
  reviewed_by_user_id         uuid REFERENCES app_user (id),
  reviewed_at                 timestamptz,
  review_source               text
                                CONSTRAINT concrete_report_version_review_source_check
                                CHECK (review_source IN ('lead_project_engineer', 'designated_reviewer')),
  -- A review stops counting when its version is returned after review (fresh review needed).
  review_cleared_at           timestamptz,
  -- Recall or return: who closed this version, when and (return: required) why.
  closed_by_user_id           uuid REFERENCES app_user (id),
  closed_at                   timestamptz,
  close_comment               text
                                CONSTRAINT concrete_report_version_close_comment_check
                                CHECK (length(btrim(close_comment)) BETWEEN 1 AND 2000),
  issued_by_user_id           uuid REFERENCES app_user (id),
  issued_at                   timestamptz,
  issue_source                text
                                CONSTRAINT concrete_report_version_issue_source_check
                                CHECK (issue_source IN ('lead_project_engineer', 'report_issuer')),
  CONSTRAINT concrete_report_version_no_key UNIQUE (field_report_id, version_no),
  CONSTRAINT concrete_report_version_report_key UNIQUE (id, field_report_id),
  -- No ON UPDATE CASCADE: a version records the project it was submitted in, so a report with
  -- versions keeps its project (a correction of a submitted record is a later, separate action).
  CONSTRAINT concrete_report_version_report_fkey FOREIGN KEY (project_id, field_report_id)
    REFERENCES concrete_field_report (project_id, id),
  CONSTRAINT concrete_report_version_revision_fkey FOREIGN KEY (revision_of_version_id, field_report_id)
    REFERENCES concrete_report_version (id, field_report_id),
  CONSTRAINT concrete_report_version_route_shape CHECK (
    (route_kind = 'designated_reviewers') = (routed_to_user_id IS NULL)
    AND (route_kind = 'designated_reviewers') = (route_reason IS NULL)
  ),
  -- Each state has exactly its columns.
  CONSTRAINT concrete_report_version_state_shape CHECK (
    CASE state
      WHEN 'submitted' THEN reviewed_at IS NULL AND closed_at IS NULL AND issued_at IS NULL
                             AND review_cleared_at IS NULL
      WHEN 'reviewed' THEN reviewed_at IS NOT NULL AND closed_at IS NULL AND issued_at IS NULL
                             AND review_cleared_at IS NULL
      WHEN 'issued' THEN reviewed_at IS NOT NULL AND closed_at IS NULL AND issued_at IS NOT NULL
                             AND review_cleared_at IS NULL
      WHEN 'recalled' THEN reviewed_at IS NULL AND closed_at IS NOT NULL AND issued_at IS NULL
                             AND review_cleared_at IS NULL
      WHEN 'returned' THEN closed_at IS NOT NULL AND close_comment IS NOT NULL AND issued_at IS NULL
                             AND (reviewed_at IS NULL) = (review_cleared_at IS NULL)
    END
  ),
  CONSTRAINT concrete_report_version_review_shape CHECK (
    (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
    AND (reviewed_at IS NULL) = (review_source IS NULL)
  ),
  CONSTRAINT concrete_report_version_close_shape CHECK (
    (closed_at IS NULL) = (closed_by_user_id IS NULL)
    AND (closed_at IS NOT NULL OR close_comment IS NULL)
  ),
  CONSTRAINT concrete_report_version_issue_shape CHECK (
    (issued_at IS NULL) = (issued_by_user_id IS NULL)
    AND (issued_at IS NULL) = (issue_source IS NULL)
  )
);
-- At most one open (awaiting review or issue) version per report: no double submission.
CREATE UNIQUE INDEX concrete_report_version_one_open
  ON concrete_report_version (field_report_id) WHERE state IN ('submitted', 'reviewed');
CREATE INDEX concrete_report_version_project_idx
  ON concrete_report_version (project_id, state, submitted_at);
CREATE INDEX concrete_report_version_routed_idx
  ON concrete_report_version (routed_to_user_id) WHERE routed_to_user_id IS NOT NULL;
CREATE INDEX concrete_report_version_submitted_by_idx ON concrete_report_version (submitted_by_user_id);
CREATE INDEX concrete_report_version_staff_idx ON concrete_report_version (submitted_staff_user_id);
CREATE INDEX concrete_report_version_reviewed_by_idx
  ON concrete_report_version (reviewed_by_user_id) WHERE reviewed_by_user_id IS NOT NULL;
CREATE INDEX concrete_report_version_closed_by_idx
  ON concrete_report_version (closed_by_user_id) WHERE closed_by_user_id IS NOT NULL;
CREATE INDEX concrete_report_version_issued_by_idx
  ON concrete_report_version (issued_by_user_id) WHERE issued_by_user_id IS NOT NULL;
CREATE INDEX concrete_report_version_revision_idx
  ON concrete_report_version (revision_of_version_id) WHERE revision_of_version_id IS NOT NULL;

-- A new version: the next number for its report, its hash from the stored snapshot, a revision
-- only of an issued version.
CREATE FUNCTION concrete_report_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_no integer;
BEGIN
  IF NEW.state <> 'submitted' THEN
    RAISE EXCEPTION 'a report version starts as submitted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_starts_submitted';
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO next_no
    FROM concrete_report_version WHERE field_report_id = NEW.field_report_id;
  IF NEW.version_no <> next_no THEN
    RAISE EXCEPTION 'report % takes version % next, not %', NEW.field_report_id, next_no, NEW.version_no
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_no_sequence';
  END IF;
  IF NEW.revision_of_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM concrete_report_version v
       WHERE v.id = NEW.revision_of_version_id AND v.state = 'issued') THEN
    RAISE EXCEPTION 'a revision corrects an issued version'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_revision_of_issued';
  END IF;
  NEW.snapshot_sha256 := encode(sha256(convert_to(NEW.snapshot::text, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_version_insert
  BEFORE INSERT ON concrete_report_version
  FOR EACH ROW EXECUTE FUNCTION concrete_report_version_insert();

-- Every update is one confirmed transition; what was submitted never changes; an issued version
-- never changes at all (AC4); no version is ever deleted.
CREATE FUNCTION concrete_report_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'report versions are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_version_no_delete';
  END IF;
  IF OLD.state = 'issued' THEN
    RAISE EXCEPTION 'issued version % never changes', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_version_issued_frozen';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.report_kind IS DISTINCT FROM OLD.report_kind
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.field_report_id IS DISTINCT FROM OLD.field_report_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.revision_of_version_id IS DISTINCT FROM OLD.revision_of_version_id
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.report_row_version IS DISTINCT FROM OLD.report_row_version
     OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
     OR NEW.submitted_staff_user_id IS DISTINCT FROM OLD.submitted_staff_user_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.route_kind IS DISTINCT FROM OLD.route_kind
     OR NEW.routed_to_user_id IS DISTINCT FROM OLD.routed_to_user_id
     OR NEW.route_reason IS DISTINCT FROM OLD.route_reason THEN
    RAISE EXCEPTION 'version % keeps what was submitted', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_version_submitted_fixed';
  END IF;
  -- A review, once recorded, keeps its reviewer and time (returning it only clears it).
  IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
       OR NEW.review_source IS DISTINCT FROM OLD.review_source) THEN
    RAISE EXCEPTION 'version % keeps its review record', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_version_review_fixed';
  END IF;
  IF NOT ((OLD.state = 'submitted' AND NEW.state IN ('recalled', 'returned', 'reviewed'))
          OR (OLD.state = 'reviewed' AND NEW.state IN ('returned', 'issued'))) THEN
    RAISE EXCEPTION 'a report version can''t go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_version_guard
  BEFORE UPDATE OR DELETE ON concrete_report_version
  FOR EACH ROW EXECUTE FUNCTION concrete_report_version_guard();
CREATE TRIGGER concrete_report_version_no_truncate
  BEFORE TRUNCATE ON concrete_report_version
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_version_guard();

-- One row per lifecycle command: the history and the exactly-once ledger (a retried request with
-- the same key and body returns the report as it stands; the same key for another request is
-- refused by the API). Append-only.
CREATE TABLE concrete_report_transition (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind           text NOT NULL DEFAULT 'field'
                          CONSTRAINT concrete_report_transition_kind_check
                          CHECK (report_kind IN ('field')),
  project_id            uuid NOT NULL REFERENCES project (id),
  field_report_id       uuid NOT NULL REFERENCES concrete_field_report (id),
  version_id            uuid NOT NULL,
  action                text NOT NULL
                          CONSTRAINT concrete_report_transition_action_check
                          CHECK (action IN ('submit', 'recall', 'return', 'resubmit', 'review',
                                            'issue', 'revise')),
  -- The report's workflow state before and after.
  from_state            text NOT NULL,
  to_state              text NOT NULL,
  actor_user_id         uuid NOT NULL REFERENCES app_user (id),
  -- The performing person when the account is the shared LAB account (attribution only).
  staff_user_id         uuid REFERENCES app_user (id),
  comment               text
                          CONSTRAINT concrete_report_transition_comment_check
                          CHECK (length(btrim(comment)) BETWEEN 1 AND 2000),
  route_kind            text,
  routed_to_user_id     uuid REFERENCES app_user (id),
  idempotency_key       uuid NOT NULL
                          CONSTRAINT concrete_report_transition_idempotency_key UNIQUE,
  request_hash          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_report_transition_version_fkey FOREIGN KEY (version_id, field_report_id)
    REFERENCES concrete_report_version (id, field_report_id),
  -- Return and revise always say why.
  CONSTRAINT concrete_report_transition_comment_required
    CHECK (action NOT IN ('return', 'revise') OR comment IS NOT NULL)
);
CREATE INDEX concrete_report_transition_report_idx
  ON concrete_report_transition (field_report_id, created_at, id);
CREATE INDEX concrete_report_transition_version_idx ON concrete_report_transition (version_id);
CREATE INDEX concrete_report_transition_project_idx ON concrete_report_transition (project_id);
CREATE INDEX concrete_report_transition_actor_idx ON concrete_report_transition (actor_user_id);
CREATE INDEX concrete_report_transition_staff_idx
  ON concrete_report_transition (staff_user_id) WHERE staff_user_id IS NOT NULL;
CREATE INDEX concrete_report_transition_routed_idx
  ON concrete_report_transition (routed_to_user_id) WHERE routed_to_user_id IS NOT NULL;

CREATE FUNCTION concrete_report_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report transitions are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_transition_append_only';
END;
$$;
CREATE TRIGGER concrete_report_transition_guard
  BEFORE UPDATE OR DELETE ON concrete_report_transition
  FOR EACH ROW EXECUTE FUNCTION concrete_report_transition_guard();
CREATE TRIGGER concrete_report_transition_no_truncate
  BEFORE TRUNCATE ON concrete_report_transition
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_transition_guard();

-- AC1: while a report is submitted or reviewed (awaiting review or issue, or issued) its content
-- is locked. Only the lifecycle columns move; recall, return or a revision reopens it. cast_at is
-- also exempt: after a set is numbered it changes only through C05's recorded casting correction
-- (reason, old and new value, dependent dates), which applies to submitted reports too; the
-- submitted versions keep the casting time as submitted.
CREATE FUNCTION concrete_field_report_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle text[] := ARRAY['workflow_state', 'ready_to_submit_at', 'submitted_at', 'issue_count',
                            'last_issued_version', 'last_issued_at', 'last_issued_by_user_id',
                            'updated_at', 'version', 'lab_manager_corrected_by_user_id',
                            'cast_at'];
BEGIN
  IF OLD.workflow_state IN ('submitted', 'reviewed')
     AND (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
    RAISE EXCEPTION 'report % is submitted and locked', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_field_report_locked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_report_locked_guard
  BEFORE UPDATE ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_locked_guard();

CREATE FUNCTION concrete_field_reading_locked_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  report_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.field_report_id ELSE NEW.field_report_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM concrete_field_report r
             WHERE r.id = report_id AND r.workflow_state IN ('submitted', 'reviewed')) THEN
    RAISE EXCEPTION 'report % is submitted and locked', report_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_field_report_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER concrete_field_reading_locked_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_field_reading
  FOR EACH ROW EXECUTE FUNCTION concrete_field_reading_locked_guard();
