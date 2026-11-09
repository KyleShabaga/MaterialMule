-- MM-V2-C39: concrete compressive strength reports on the C09 report lifecycle.
--
-- Provisional report designs (G2, owner direction 2026-11-09), section 4: one strength report per
-- specimen set, cumulative. The first submission needs the set's first test age complete; every
-- later age is a revision of the same report (Rev 1, Rev 2 …), so the latest revision shows every
-- age tested so far. Strength, area, averages and assessment stay empty until C24 (G1/G8).
--
-- The report row (concrete_strength_report) is the current state, like concrete_field_report.
-- Versions, transitions and exception notes are C09's / C28's tables, which now take a report of
-- either kind: exactly one of field_report_id / strength_report_id, matching report_kind. Every
-- rule those tables enforce (version numbering, one open version, revisions of issued versions,
-- frozen snapshots with their SHA-256, append-only history) applies per strength report too.
--
-- Corrections after issue need a revision: a test result shown as tested on a submitted,
-- reviewed or issued strength report version is locked until the report is recalled, returned or
-- revised (back to draft). Results of specimens the version doesn't show as tested (later ages)
-- stay open for entry.
--
-- Lock order (D09): the strength report row FOR UPDATE, its latest version FOR UPDATE, the set's
-- test results FOR SHARE, then the project and the accounts FOR SHARE, then the transition ledger.

CREATE TABLE concrete_strength_report (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL,
  specimen_set_id          uuid NOT NULL,
  -- draft (after a recall or a revision), submitted, returned, reviewed (issued shows as
  -- reviewed with an issued latest version, as for field reports).
  workflow_state           text NOT NULL DEFAULT 'draft'
                             CONSTRAINT concrete_strength_report_state_check
                             CHECK (workflow_state IN ('draft', 'submitted', 'returned', 'reviewed')),
  submitted_at             timestamptz,
  issue_count              integer NOT NULL DEFAULT 0
                             CONSTRAINT concrete_strength_report_issue_count_check
                             CHECK (issue_count >= 0),
  last_issued_version      integer,
  last_issued_at           timestamptz,
  last_issued_by_user_id   uuid REFERENCES app_user (id),
  created_by_user_id       uuid NOT NULL REFERENCES app_user (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer NOT NULL DEFAULT 1
                             CONSTRAINT concrete_strength_report_version_check CHECK (version >= 1),
  CONSTRAINT concrete_strength_report_set_key UNIQUE (specimen_set_id),
  CONSTRAINT concrete_strength_report_project_id_key UNIQUE (project_id, id),
  -- No ON UPDATE CASCADE: a strength report keeps the project its set had (as report versions do).
  CONSTRAINT concrete_strength_report_set_fkey FOREIGN KEY (project_id, specimen_set_id)
    REFERENCES concrete_specimen_set (project_id, id),
  CONSTRAINT concrete_strength_report_issue_shape CHECK (
    (issue_count = 0) = (last_issued_version IS NULL)
    AND (issue_count = 0) = (last_issued_at IS NULL)
    AND (issue_count = 0) = (last_issued_by_user_id IS NULL)
  ),
  CONSTRAINT concrete_strength_report_submitted_shape CHECK (
    workflow_state = 'draft' OR submitted_at IS NOT NULL
  )
);
CREATE INDEX concrete_strength_report_project_idx
  ON concrete_strength_report (project_id, workflow_state);
CREATE INDEX concrete_strength_report_created_by_idx ON concrete_strength_report (created_by_user_id);
CREATE INDEX concrete_strength_report_issued_by_idx
  ON concrete_strength_report (last_issued_by_user_id) WHERE last_issued_by_user_id IS NOT NULL;

-- A strength report is never deleted; it keeps its set, project and creator. Its CS number lives
-- only in C32's concrete_report_number (subject = this report), which never changes.

CREATE FUNCTION concrete_strength_report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'strength reports are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_strength_report_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.specimen_set_id IS DISTINCT FROM OLD.specimen_set_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'strength report % keeps its identity', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_strength_report_identity';
  END IF;
  IF NEW.issue_count < OLD.issue_count THEN
    RAISE EXCEPTION 'strength report % never loses an issue', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_strength_report_issue_count_fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_strength_report_guard
  BEFORE UPDATE OR DELETE ON concrete_strength_report
  FOR EACH ROW EXECUTE FUNCTION concrete_strength_report_guard();
CREATE TRIGGER concrete_strength_report_no_truncate
  BEFORE TRUNCATE ON concrete_strength_report
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_strength_report_guard();

-- ---- Versions: either kind ------------------------------------------------------------------------

ALTER TABLE concrete_report_version
  DROP CONSTRAINT concrete_report_version_kind_check,
  ADD CONSTRAINT concrete_report_version_kind_check CHECK (report_kind IN ('field', 'strength')),
  ALTER COLUMN field_report_id DROP NOT NULL,
  ADD COLUMN strength_report_id uuid,
  ADD CONSTRAINT concrete_report_version_report_shape CHECK (
    CASE report_kind
      WHEN 'field' THEN field_report_id IS NOT NULL AND strength_report_id IS NULL
      WHEN 'strength' THEN strength_report_id IS NOT NULL AND field_report_id IS NULL
    END
  ),
  ADD CONSTRAINT concrete_report_version_strength_no_key UNIQUE (strength_report_id, version_no),
  ADD CONSTRAINT concrete_report_version_strength_report_key UNIQUE (id, strength_report_id),
  ADD CONSTRAINT concrete_report_version_strength_fkey FOREIGN KEY (project_id, strength_report_id)
    REFERENCES concrete_strength_report (project_id, id),
  ADD CONSTRAINT concrete_report_version_strength_revision_fkey
    FOREIGN KEY (revision_of_version_id, strength_report_id)
    REFERENCES concrete_report_version (id, strength_report_id);
CREATE UNIQUE INDEX concrete_report_version_strength_one_open
  ON concrete_report_version (strength_report_id) WHERE state IN ('submitted', 'reviewed');

-- Report numbers (C32, 0031): one source of truth, concrete_report_number (kind 'strength',
-- subject = the strength report), taken at first issue and kept by every revision. Every issued
-- strength version records it (and the template it was rendered with, 0031's output shape), and
-- a version's number is its own report's, whichever kind (0031's check named field reports only).
ALTER TABLE concrete_report_version
  ADD CONSTRAINT concrete_report_version_strength_numbered CHECK (
    report_kind <> 'strength' OR state <> 'issued' OR report_number_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION concrete_report_version_number_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.report_number_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM concrete_report_number n
       WHERE n.id = NEW.report_number_id AND n.report_kind = NEW.report_kind
         AND n.subject_id = coalesce(NEW.field_report_id, NEW.strength_report_id)
         AND n.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a version takes its own report''s number'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_own_number';
  END IF;
  RETURN NEW;
END;
$$;

-- As 0021, per report of either kind.
CREATE OR REPLACE FUNCTION concrete_report_version_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_no integer;
BEGIN
  IF NEW.state <> 'submitted' THEN
    RAISE EXCEPTION 'a report version starts as submitted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_starts_submitted';
  END IF;
  IF NEW.report_kind = 'strength' THEN
    SELECT coalesce(max(version_no), 0) + 1 INTO next_no
      FROM concrete_report_version WHERE strength_report_id = NEW.strength_report_id;
  ELSE
    SELECT coalesce(max(version_no), 0) + 1 INTO next_no
      FROM concrete_report_version WHERE field_report_id = NEW.field_report_id;
  END IF;
  IF NEW.version_no <> next_no THEN
    RAISE EXCEPTION 'the report takes version % next, not %', next_no, NEW.version_no
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

CREATE OR REPLACE FUNCTION concrete_report_version_guard() RETURNS trigger
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
     OR NEW.strength_report_id IS DISTINCT FROM OLD.strength_report_id
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

-- ---- Transitions: either kind ---------------------------------------------------------------------

ALTER TABLE concrete_report_transition
  DROP CONSTRAINT concrete_report_transition_kind_check,
  ADD CONSTRAINT concrete_report_transition_kind_check CHECK (report_kind IN ('field', 'strength')),
  ALTER COLUMN field_report_id DROP NOT NULL,
  ADD COLUMN strength_report_id uuid REFERENCES concrete_strength_report (id),
  ADD CONSTRAINT concrete_report_transition_report_shape CHECK (
    CASE report_kind
      WHEN 'field' THEN field_report_id IS NOT NULL AND strength_report_id IS NULL
      WHEN 'strength' THEN strength_report_id IS NOT NULL AND field_report_id IS NULL
    END
  ),
  ADD CONSTRAINT concrete_report_transition_strength_version_fkey
    FOREIGN KEY (version_id, strength_report_id)
    REFERENCES concrete_report_version (id, strength_report_id);
CREATE INDEX concrete_report_transition_strength_idx
  ON concrete_report_transition (strength_report_id, created_at, id)
  WHERE strength_report_id IS NOT NULL;

-- ---- Exception notes: either kind (C28) -----------------------------------------------------------

ALTER TABLE concrete_report_exception_note
  ALTER COLUMN field_report_id DROP NOT NULL,
  ADD COLUMN strength_report_id uuid REFERENCES concrete_strength_report (id),
  ADD CONSTRAINT concrete_report_exception_note_report_shape CHECK (
    (field_report_id IS NULL) <> (strength_report_id IS NULL)
  ),
  ADD CONSTRAINT concrete_report_exception_note_strength_version_fkey
    FOREIGN KEY (version_id, strength_report_id)
    REFERENCES concrete_report_version (id, strength_report_id);
CREATE INDEX concrete_report_exception_note_strength_idx
  ON concrete_report_exception_note (strength_report_id) WHERE strength_report_id IS NOT NULL;

CREATE OR REPLACE FUNCTION concrete_report_exception_note_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM concrete_report_version v
       WHERE v.id = NEW.version_id
         AND v.field_report_id IS NOT DISTINCT FROM NEW.field_report_id
         AND v.strength_report_id IS NOT DISTINCT FROM NEW.strength_report_id
         AND v.project_id = NEW.project_id AND v.state = 'submitted') THEN
    RAISE EXCEPTION 'exceptions are documented on a version awaiting review'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_exception_note_open_version';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Results shown on a strength report are locked ------------------------------------------------

-- A result (any attempt) of a specimen that the strength report's latest version shows as tested
-- is locked while that report is submitted, reviewed or issued (workflow submitted / reviewed).
-- A correction then needs a recall (not yet reviewed), a return, or a revision after issue.
-- A project correction cascading down (project_id only) is left to the foreign keys.
CREATE FUNCTION concrete_test_result_reported_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
       SELECT 1
       FROM concrete_specimen sp
       JOIN concrete_strength_report r ON r.specimen_set_id = sp.set_id
       CROSS JOIN LATERAL (
         SELECT v.snapshot FROM concrete_report_version v
         WHERE v.strength_report_id = r.id ORDER BY v.version_no DESC LIMIT 1
       ) v
       WHERE sp.id = NEW.specimen_id
         AND r.workflow_state IN ('submitted', 'reviewed')
         AND v.snapshot->'results' @> jsonb_build_array(
               jsonb_build_object('specimenId', sp.id::text, 'reported', true))) THEN
    RAISE EXCEPTION 'this result is on a submitted or issued strength report'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_reported';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_test_result_reported_guard
  BEFORE INSERT OR UPDATE ON concrete_test_result
  FOR EACH ROW EXECUTE FUNCTION concrete_test_result_reported_guard();
