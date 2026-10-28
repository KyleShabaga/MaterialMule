-- MM-T23: lab test catalogue, testing templates, testing programs (drafts and submission),
-- testing lines, test requests and the coverage frozen at submission.
--
-- Catalogue: groups → optional subgroups → test entries. An entry keeps its exact source code and
-- full description as separate fields, plus an optional concise display name (the description is
-- shown when there is none). No costs are stored anywhere. Entries, templates, groups and
-- subgroups are retired or renamed, never deleted, so every reference stays readable. The two
-- groups the owner named (Soils, Advanced Soils) are reference data (seed/reference.sql), not an
-- enum: Lab Managers may add more.
--
-- Program lifecycle: draft → submitted (→ closed by MM-T26). Drafts are workable only by the
-- account that created them (the shared LAB account's drafts by any LAB station); each draft is
-- its own row with its own version, so stations never share a "current draft". Program numbers
-- (LP-YYYY-NNNN) are issued at submission, never for a draft.
--
-- Testing line: one project-scoped sampling source, chosen explicitly:
--   * test_hole: a hole of the program's project;
--   * standalone_unit: a Shelby tube whose own source is a standalone sampling location;
--   * standalone_bulk_group: a bulk-sample group whose source is a standalone location.
-- Standalone locations are free text on each unit or group (MM-T36, no directory), so equal text
-- never merges two of them into one source: each tube or group is its own source. No placeholder
-- test hole is ever created.
--
-- Scope: all / grabs / spt / specific. Coverage of all/grabs/spt lines is computed when the
-- program is submitted and frozen in program_scope_snapshot, with the matching basis and display
-- snapshots; later receipts or group changes never extend it (MM-T26 owns reviewed amendments).
-- Coverage is potential material, never proof that a unit was tested.
--
-- Request snapshots: each test request copies the test's code, display name, description, group
-- and subgroup in the submission transaction, so later catalogue edits can't rewrite history.

-- ---------------------------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------------------------

CREATE TABLE test_group (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_group_name_key UNIQUE (name_normalized)
);

CREATE TABLE test_subgroup (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         uuid NOT NULL REFERENCES test_group (id),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_subgroup_name_key UNIQUE (group_id, name_normalized),
  -- Target of the composite FK that keeps a test's subgroup inside the test's group.
  CONSTRAINT test_subgroup_group_id_key UNIQUE (group_id, id)
);

CREATE TABLE test_type (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES test_group (id),
  subgroup_id  uuid,
  -- Exact source code as supplied (case, punctuation, hyphens and underscores preserved).
  code         text NOT NULL
                 CHECK (code = btrim(code) AND length(code) BETWEEN 1 AND 40
                        AND code !~ '[[:cntrl:]]'),
  -- Optional concise display name; never replaces the description.
  name         text CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120
                           AND name !~ '[[:cntrl:]]'),
  -- Complete detailed description, never truncated.
  description  text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- A code identifies one entry, retired or not: a retired entry is restored, never re-created.
  -- (Revisit only if the workbook reconciliation finds legitimate duplicate codes.)
  CONSTRAINT test_type_code_key UNIQUE (code),
  -- The subgroup, when there is one, belongs to the test's group.
  CONSTRAINT test_type_subgroup_fk FOREIGN KEY (group_id, subgroup_id)
    REFERENCES test_subgroup (group_id, id),
  CONSTRAINT test_type_retired_check CHECK (active = (retired_at IS NULL))
);
CREATE INDEX test_type_group_idx ON test_type (group_id, subgroup_id, sort_order);

CREATE TABLE test_template (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  active           boolean NOT NULL DEFAULT true,
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_template_name_key UNIQUE (name_normalized),
  CONSTRAINT test_template_retired_check CHECK (active = (retired_at IS NULL))
);

CREATE TABLE test_template_item (
  template_id   uuid NOT NULL REFERENCES test_template (id) ON DELETE CASCADE,
  test_type_id  uuid NOT NULL REFERENCES test_type (id),
  sort_order    integer NOT NULL DEFAULT 0,
  -- A test appears at most once in a template.
  PRIMARY KEY (template_id, test_type_id)
);

-- Catalogue rows are retired, never deleted (templates' items are replaced by an edit).
CREATE FUNCTION lab_catalogue_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be deleted; retire or rename them instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER test_group_no_delete BEFORE DELETE ON test_group
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_subgroup_no_delete BEFORE DELETE ON test_subgroup
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_type_no_delete BEFORE DELETE ON test_type
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_template_no_delete BEFORE DELETE ON test_template
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();

-- A subgroup never moves to another group: its tests' composite FK would otherwise dangle.
CREATE FUNCTION test_subgroup_group_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'test subgroup % can''t move to another group', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_subgroup_group_immutable
  BEFORE UPDATE OF group_id ON test_subgroup
  FOR EACH ROW EXECUTE FUNCTION test_subgroup_group_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- Testing programs
-- ---------------------------------------------------------------------------------------------

-- One counter per year for LP-YYYY-NNNN, used only at submission.
CREATE TABLE lab_program_counter (
  year        integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 9999),
  last_value  integer NOT NULL DEFAULT 0 CHECK (last_value BETWEEN 0 AND 9999)
);

CREATE TABLE lab_program (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                       uuid NOT NULL REFERENCES project (id),
  program_number                   text UNIQUE CHECK (program_number ~ '^LP-[0-9]{4}-[0-9]{4}$'),
  status                           text NOT NULL DEFAULT 'draft'
                                     CHECK (status IN ('draft', 'submitted', 'closed')),
  -- D51: Normal unless the project's PM/PE or a Lab Manager says otherwise (MM-T24).
  priority                         text NOT NULL DEFAULT 'normal'
                                     CHECK (priority IN ('normal', 'urgent')),
  notes                            text CHECK (length(notes) <= 2000),
  -- The authenticated account that created the draft (e.g. LAB) ...
  created_by_account_user_id       uuid NOT NULL REFERENCES app_user (id),
  created_by_account_type          text NOT NULL
                                     CHECK (created_by_account_type IN ('personal', 'shared_lab', 'test')),
  -- ... and the person it is requested by, copied when chosen ("LAB for person").
  requested_by_user_id             uuid NOT NULL REFERENCES app_user (id),
  requested_by_initials_snapshot   text CHECK (length(requested_by_initials_snapshot) BETWEEN 1 AND 5),
  requested_by_name_snapshot       text NOT NULL
                                     CHECK (length(requested_by_name_snapshot) BETWEEN 1 AND 200),
  -- A retried "create draft" returns the draft it made the first time.
  create_idempotency_key           uuid NOT NULL UNIQUE,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  version                          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at                     timestamptz,
  submitted_by_account_user_id     uuid REFERENCES app_user (id),
  submitted_by_account_type        text
                                     CHECK (submitted_by_account_type IN ('personal', 'shared_lab', 'test')),
  submitted_by_initials_snapshot   text,
  submitted_by_name_snapshot       text,
  submitted_for_user_id            uuid REFERENCES app_user (id),
  submitted_for_initials_snapshot  text,
  submitted_for_name_snapshot      text,
  -- A retried submission with the same key returns the original result.
  submit_idempotency_key           uuid UNIQUE,
  CONSTRAINT lab_program_project_id_key UNIQUE (project_id, id),
  CONSTRAINT lab_program_submission_check CHECK (
    (status = 'draft' AND program_number IS NULL AND submitted_at IS NULL
     AND submitted_by_account_user_id IS NULL AND submit_idempotency_key IS NULL)
    OR (status <> 'draft' AND program_number IS NOT NULL AND submitted_at IS NOT NULL
        AND submitted_by_account_user_id IS NOT NULL AND submitted_by_account_type IS NOT NULL
        AND submitted_by_name_snapshot IS NOT NULL AND submitted_for_user_id IS NOT NULL
        AND submitted_for_name_snapshot IS NOT NULL AND submit_idempotency_key IS NOT NULL)
  )
);
CREATE INDEX lab_program_project_idx ON lab_program (project_id, status);
CREATE INDEX lab_program_status_idx ON lab_program (status, priority, submitted_at, id);
CREATE INDEX lab_program_draft_owner_idx ON lab_program (created_by_account_user_id)
  WHERE status = 'draft';

CREATE TABLE test_line (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                 uuid NOT NULL,
  project_id                 uuid NOT NULL,
  line_number                integer NOT NULL CHECK (line_number BETWEEN 1 AND 200),
  -- The sampling source; null only while the draft is incomplete.
  source_kind                text
                               CHECK (source_kind IN ('test_hole', 'standalone_unit',
                                                      'standalone_bulk_group')),
  test_hole_id               uuid,
  source_storage_unit_id     uuid,
  source_bulk_group_id       uuid,
  scope                      text NOT NULL DEFAULT 'all'
                               CHECK (scope IN ('all', 'grabs', 'spt', 'specific')),
  -- Specific sample: full label (G3, S3, B1, T5 …) as entered; identity compares it ignoring case.
  sample_label               text CHECK (sample_label = btrim(sample_label)
                                         AND length(sample_label) BETWEEN 1 AND 40
                                         AND sample_label !~ '[[:cntrl:]]'),
  depth_mode                 text CHECK (depth_mode IN ('point', 'interval')),
  depth_from                 numeric(8, 2) CHECK (depth_from >= 0),
  depth_to                   numeric(8, 2),
  depth_unit                 text CHECK (depth_unit IN ('ft', 'm')),
  -- Depths of the same sample identity the requester acknowledged as differing (e.g. 7.5 ft and
  -- 8 ft), as normalised depth texts. Submission needs every current variant acknowledged.
  acknowledged_depths        text[] NOT NULL DEFAULT '{}',
  -- Frozen at submission: the source as it read then, and when coverage was captured.
  source_display_snapshot    text,
  coverage_captured_at       timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_line_program_fk FOREIGN KEY (project_id, program_id)
    REFERENCES lab_program (project_id, id),
  -- Every source belongs to the program's project.
  CONSTRAINT test_line_test_hole_fk FOREIGN KEY (project_id, test_hole_id)
    REFERENCES test_hole (project_id, id),
  CONSTRAINT test_line_source_unit_fk FOREIGN KEY (project_id, source_storage_unit_id)
    REFERENCES storage_unit (project_id, id),
  CONSTRAINT test_line_source_bulk_group_fk FOREIGN KEY (project_id, source_bulk_group_id)
    REFERENCES bulk_group (project_id, id),
  -- Deferred so a saved draft can renumber its lines in one statement sequence.
  CONSTRAINT test_line_number_key UNIQUE (program_id, line_number) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT test_line_program_id_key UNIQUE (program_id, id),
  -- Exactly the reference its source kind names, and nothing else.
  CONSTRAINT test_line_source_check CHECK (
    CASE source_kind
      WHEN 'test_hole' THEN test_hole_id IS NOT NULL AND source_storage_unit_id IS NULL
                            AND source_bulk_group_id IS NULL
      WHEN 'standalone_unit' THEN source_storage_unit_id IS NOT NULL AND test_hole_id IS NULL
                                  AND source_bulk_group_id IS NULL
      WHEN 'standalone_bulk_group' THEN source_bulk_group_id IS NOT NULL AND test_hole_id IS NULL
                                        AND source_storage_unit_id IS NULL
      ELSE test_hole_id IS NULL AND source_storage_unit_id IS NULL AND source_bulk_group_id IS NULL
    END
  ),
  -- ALL / Grabs / SPT lines carry no label or depth; a depth always has its mode and unit.
  CONSTRAINT test_line_scope_shape_check CHECK (
    (scope <> 'specific' AND sample_label IS NULL AND depth_mode IS NULL AND depth_from IS NULL
     AND depth_to IS NULL AND depth_unit IS NULL)
    OR scope = 'specific'
  ),
  CONSTRAINT test_line_depth_shape_check CHECK (
    (depth_mode IS NULL AND depth_from IS NULL AND depth_to IS NULL)
    OR (depth_mode = 'point' AND depth_to IS NULL)
    OR (depth_mode = 'interval' AND (depth_to IS NULL OR depth_from IS NULL
                                     OR depth_to >= depth_from))
  )
);
CREATE INDEX test_line_program_idx ON test_line (program_id, line_number);
CREATE INDEX test_line_identity_idx ON test_line (project_id, upper(sample_label))
  WHERE scope = 'specific';

-- Tests picked on a draft line (current catalogue values; snapshots are taken at submission).
CREATE TABLE test_line_test (
  line_id       uuid NOT NULL REFERENCES test_line (id) ON DELETE CASCADE,
  test_type_id  uuid NOT NULL REFERENCES test_type (id),
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (line_id, test_type_id)
);

-- Units the requester explicitly chose on a draft line: Grabs/SPT units with unknown G/S
-- classification they reviewed and included, or the physical units of a Specific sample where
-- known. Same-project only.
CREATE TABLE test_line_unit_choice (
  line_id          uuid NOT NULL REFERENCES test_line (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL,
  storage_unit_id  uuid NOT NULL,
  PRIMARY KEY (line_id, storage_unit_id),
  CONSTRAINT test_line_unit_choice_unit_fk FOREIGN KEY (project_id, storage_unit_id)
    REFERENCES storage_unit (project_id, id)
);
CREATE INDEX test_line_unit_choice_unit_idx ON test_line_unit_choice (storage_unit_id);

-- Coverage frozen at submission: every candidate unit of an ALL / Grabs / SPT line (included or
-- reviewed and excluded) and the explicitly chosen units of a Specific line, with how it matched
-- and how it read then. Append-only.
CREATE TABLE program_scope_snapshot (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                uuid NOT NULL,
  line_id                   uuid NOT NULL,
  storage_unit_id           uuid NOT NULL REFERENCES storage_unit (id),
  receipt_id                uuid NOT NULL REFERENCES receipt (id),
  -- The unit's project at capture (kept even if the unit's project is corrected later).
  project_id                uuid NOT NULL REFERENCES project (id),
  included                  boolean NOT NULL,
  -- Why the unit is (or isn't) covered:
  --   hole_summary, tube_source, bulk_group_source: it came from the selected test hole;
  --   standalone_unit, bulk_group_member: it is the selected standalone source (or a member);
  --   reviewed_included / unknown_classification_excluded: Grabs/SPT unit without structured G/S
  --     classification that the requester explicitly included or left out;
  --   explicit_selection: a physical unit the requester linked to a Specific sample.
  matching_basis            text NOT NULL
                              CHECK (matching_basis IN ('hole_summary', 'tube_source',
                                     'bulk_group_source', 'standalone_unit', 'bulk_group_member',
                                     'reviewed_included', 'unknown_classification_excluded',
                                     'explicit_selection')),
  unit_readable_id_snapshot text NOT NULL,
  unit_type_snapshot        text NOT NULL,
  contents_snapshot         text,
  received_date_snapshot    date NOT NULL,
  captured_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT program_scope_snapshot_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id),
  CONSTRAINT program_scope_snapshot_unit_key UNIQUE (line_id, storage_unit_id),
  CONSTRAINT program_scope_snapshot_basis_check CHECK (
    included = (matching_basis <> 'unknown_classification_excluded')
  )
);
CREATE INDEX program_scope_snapshot_unit_idx ON program_scope_snapshot (storage_unit_id);
CREATE INDEX program_scope_snapshot_program_idx ON program_scope_snapshot (program_id);

-- One requested test per line and test, created at submission with catalogue snapshots.
CREATE TABLE test_request (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                  uuid NOT NULL,
  line_id                     uuid NOT NULL,
  test_type_id                uuid NOT NULL REFERENCES test_type (id),
  test_code_snapshot          text NOT NULL,
  test_name_snapshot          text,
  test_description_snapshot   text NOT NULL,
  test_group_snapshot         text NOT NULL,
  test_subgroup_snapshot      text,
  sort_order                  integer NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_request_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id),
  CONSTRAINT test_request_line_test_key UNIQUE (line_id, test_type_id)
);
CREATE INDEX test_request_program_idx ON test_request (program_id);
CREATE INDEX test_request_test_type_idx ON test_request (test_type_id);

-- ---------------------------------------------------------------------------------------------
-- Lifecycle integrity
-- ---------------------------------------------------------------------------------------------

-- A program never returns to draft and never changes project; a submitted program's submission
-- facts are permanent. Submitting needs every line complete (source, tests, Specific identity).
CREATE FUNCTION lab_program_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'program % has been submitted and can''t be deleted', OLD.program_number
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'program % project can''t change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft'
       OR NEW.program_number IS DISTINCT FROM OLD.program_number
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_account_user_id IS DISTINCT FROM OLD.submitted_by_account_user_id
       OR NEW.submitted_for_user_id IS DISTINCT FROM OLD.submitted_for_user_id
       OR NEW.submit_idempotency_key IS DISTINCT FROM OLD.submit_idempotency_key
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
       OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'program % has been submitted; its submission can''t change',
        OLD.program_number USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status = 'closed' THEN
    RAISE EXCEPTION 'a draft program can''t be closed; submit or discard it'
      USING ERRCODE = 'restrict_violation';
  ELSIF NEW.status = 'submitted' THEN
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id)
               THEN 'has no testing lines'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id AND source_kind IS NULL)
               THEN 'has a line without a sampling source'
             WHEN EXISTS (SELECT 1 FROM test_line l WHERE l.program_id = NEW.id
                          AND NOT EXISTS (SELECT 1 FROM test_request r WHERE r.line_id = l.id))
               THEN 'has a line without requested tests'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id AND scope = 'specific'
                          AND (sample_label IS NULL OR depth_mode IS NULL OR depth_from IS NULL
                               OR depth_unit IS NULL
                               OR (depth_mode = 'interval' AND depth_to IS NULL)))
               THEN 'has a specific sample without label, depth and unit'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id
                          AND (source_display_snapshot IS NULL OR coverage_captured_at IS NULL))
               THEN 'has a line whose coverage was not captured'
           END INTO problem;
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'program % %', NEW.id, problem
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_complete_on_submit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_program_guard
  BEFORE UPDATE OR DELETE ON lab_program
  FOR EACH ROW EXECUTE FUNCTION lab_program_guard();

-- Lines, picked tests and unit choices change only while their program is a draft. The line's
-- frozen snapshot columns may be written once, in the submission transaction (still draft).
CREATE FUNCTION lab_program_is_draft(program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT status = 'draft' FROM lab_program WHERE id = program
$$;

CREATE FUNCTION test_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program uuid;
BEGIN
  program := CASE WHEN TG_OP = 'DELETE' THEN OLD.program_id ELSE NEW.program_id END;
  IF NOT coalesce(lab_program_is_draft(program), true) THEN
    RAISE EXCEPTION 'testing lines of a submitted program can''t change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER test_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line
  FOR EACH ROW EXECUTE FUNCTION test_line_guard();

CREATE FUNCTION test_line_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  line uuid;
BEGIN
  line := CASE WHEN TG_OP = 'DELETE' THEN OLD.line_id ELSE NEW.line_id END;
  IF NOT coalesce((SELECT lab_program_is_draft(program_id) FROM test_line WHERE id = line), true)
  THEN
    RAISE EXCEPTION '% of a submitted program can''t change', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER test_line_test_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line_test
  FOR EACH ROW EXECUTE FUNCTION test_line_child_guard();
CREATE TRIGGER test_line_unit_choice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line_unit_choice
  FOR EACH ROW EXECUTE FUNCTION test_line_child_guard();

-- Snapshots are written once, while the program is being submitted, and never changed.
CREATE FUNCTION program_scope_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'frozen coverage can''t be changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT coalesce(lab_program_is_draft(NEW.program_id), false) THEN
    RAISE EXCEPTION 'coverage is frozen when the program is submitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER program_scope_snapshot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON program_scope_snapshot
  FOR EACH ROW EXECUTE FUNCTION program_scope_snapshot_guard();

-- Requests are created in the submission transaction; their catalogue snapshots never change and
-- requests are never deleted (cancellation is MM-T26).
CREATE FUNCTION test_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'test requests can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT coalesce(lab_program_is_draft(NEW.program_id), false) THEN
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'test request % snapshot is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_guard();
