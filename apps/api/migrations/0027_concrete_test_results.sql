-- MM-V2-C07: concrete test-result drafts, tester attribution and correction history. Adds two
-- tables; changes no existing row or table.
--
-- One row per result attempt on a specimen (a stable identity the client chooses, so a retry or
-- an offline resend never creates a second attempt). Readings are manual: the machine's maximum
-- load and the specimen's height and diameter readings. Units are stored with the row; kN and mm
-- are provisional (owner input G2/G8) and are the only units accepted until the worksheet is
-- verified, as is the number of dimension readings (0 to 10 each here, none required).
--
-- Drafts only. `state` admits 'draft' alone: completed-test semantics, strength, rounding,
-- pass/fail, end preparation and fracture type wait for the verified worksheet and methods (C23).
-- The calculation method/version and the reviewed/issued report version are prepared as empty
-- columns that nothing here writes; no strength value is stored anywhere. Photos stay optional:
-- there is no photo column and nothing requires one (attachments are C15's).
--
-- Every save appends a revision with the changed fields (before/after), who entered it (the
-- account and, on LAB, the named staff member) and when. Filling an empty field is initial entry;
-- changing or clearing a saved value is a correction and needs a reason (checked here and in the
-- API). The tester and actual test date are values on the row: a later page default never touches
-- them, and changing a saved one is a correction like any other.

CREATE TABLE concrete_test_result (
  id                          uuid PRIMARY KEY,
  project_id                  uuid NOT NULL,
  specimen_id                 uuid NOT NULL,
  -- 1, 2, 3 … per specimen in creation order (a retest is a new attempt, never an overwrite).
  attempt_no                  integer NOT NULL
                                CONSTRAINT concrete_test_result_attempt_no_check CHECK (attempt_no >= 1),
  state                       text NOT NULL DEFAULT 'draft'
                                CONSTRAINT concrete_test_result_state_check CHECK (state IN ('draft')),
  -- The actual test date (not the entry time) and the person who tested. Empty until entered.
  tested_on                   date,
  tester_user_id              uuid REFERENCES app_user (id),
  tester_initials_snapshot    text,
  tester_name_snapshot        text,
  -- Manual readings. Empty is "not entered", never zero.
  max_load                    numeric
                                CONSTRAINT concrete_test_result_max_load_check
                                CHECK (max_load IS NULL OR (max_load > 0 AND max_load < 100000)),
  load_unit                   text NOT NULL DEFAULT 'kN'
                                CONSTRAINT concrete_test_result_load_unit_check CHECK (load_unit IN ('kN')),
  height_readings             numeric[] NOT NULL DEFAULT '{}',
  diameter_readings           numeric[] NOT NULL DEFAULT '{}',
  dimension_unit              text NOT NULL DEFAULT 'mm'
                                CONSTRAINT concrete_test_result_dimension_unit_check
                                CHECK (dimension_unit IN ('mm')),
  units_provisional           boolean NOT NULL DEFAULT true
                                CONSTRAINT concrete_test_result_units_provisional_check
                                CHECK (units_provisional),
  notes                       text
                                CONSTRAINT concrete_test_result_notes_check
                                CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  -- The registered testing machine when the attempt was created (CD-44: no selector; may be none).
  testing_machine_id          uuid REFERENCES concrete_equipment (id),
  -- Prepared for C23/C28; nothing writes these until the method is verified.
  calculation_method          text,
  calculation_method_version  text,
  report_version_id           uuid REFERENCES concrete_report_version (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1
                                CONSTRAINT concrete_test_result_version_check CHECK (version >= 1),
  CONSTRAINT concrete_test_result_project_id_key UNIQUE (project_id, id),
  CONSTRAINT concrete_test_result_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_test_result_attempt_key UNIQUE (specimen_id, attempt_no),
  CONSTRAINT concrete_test_result_tester_snapshot CHECK (
    (tester_user_id IS NULL AND tester_name_snapshot IS NULL AND tester_initials_snapshot IS NULL)
    OR (tester_user_id IS NOT NULL AND tester_name_snapshot IS NOT NULL)
  ),
  CONSTRAINT concrete_test_result_readings_check CHECK (
    cardinality(height_readings) <= 10 AND cardinality(diameter_readings) <= 10
    AND array_position(height_readings, NULL) IS NULL
    AND array_position(diameter_readings, NULL) IS NULL
    AND 0 < ALL (height_readings) AND 10000 > ALL (height_readings)
    AND 0 < ALL (diameter_readings) AND 10000 > ALL (diameter_readings)
  ),
  -- No method, no calculated anything (AC5); no report link on a draft.
  CONSTRAINT concrete_test_result_method_gated CHECK (
    calculation_method IS NULL AND calculation_method_version IS NULL AND report_version_id IS NULL
  ),
  CONSTRAINT concrete_test_result_updated_check CHECK (updated_at >= created_at)
);
CREATE INDEX concrete_test_result_project_idx ON concrete_test_result (project_id);
CREATE INDEX concrete_test_result_tester_idx
  ON concrete_test_result (tester_user_id) WHERE tester_user_id IS NOT NULL;

-- The tester is a person: an active personal or test account, never a shared account (checked
-- when set or changed; a later disable doesn't rewrite history).
CREATE FUNCTION concrete_test_result_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'concrete test results are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_kept';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.specimen_id IS DISTINCT FROM OLD.specimen_id
      OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
      OR NEW.testing_machine_id IS DISTINCT FROM OLD.testing_machine_id) THEN
    RAISE EXCEPTION 'test result % keeps its identity', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_identity';
  END IF;
  IF NEW.tester_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.tester_user_id IS DISTINCT FROM OLD.tester_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM app_user u
       WHERE u.id = NEW.tester_user_id AND u.status = 'active'
         AND u.account_type IN ('personal', 'test')
     ) THEN
    RAISE EXCEPTION 'a concrete tester must be an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_test_result_tester_check';
  END IF;
  -- Every change to the row comes with its revision in the same transaction (exact version).
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NOT EXISTS (
       SELECT 1 FROM concrete_test_result_revision r
       WHERE r.result_id = OLD.id AND r.revision_no = NEW.version
         AND r.transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'test result % changes only with a recorded revision', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_revision_required';
  END IF;
  RETURN NEW;
END;
$$;

-- The history: one row per committed save, append-only.
CREATE TABLE concrete_test_result_revision (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL,
  result_id                   uuid NOT NULL,
  -- The result version this save produced (1 = the first save).
  revision_no                 integer NOT NULL
                                CONSTRAINT concrete_test_result_revision_no_check CHECK (revision_no >= 1),
  -- initial: the first save; entry: only empty fields filled; correction: a saved value changed.
  kind                        text NOT NULL
                                CONSTRAINT concrete_test_result_revision_kind_check
                                CHECK (kind IN ('initial', 'entry', 'correction')),
  -- { field: { "before": …, "after": … } } for every field the save changed.
  changes                     jsonb NOT NULL
                                CONSTRAINT concrete_test_result_revision_changes_check
                                CHECK (jsonb_typeof(changes) = 'object'),
  reason                      text
                                CONSTRAINT concrete_test_result_revision_reason_check
                                CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  -- The signed-in account (may be LAB) and the staff member credited with the entry (never LAB).
  account_user_id             uuid NOT NULL REFERENCES app_user (id),
  account_type                text NOT NULL
                                CONSTRAINT concrete_test_result_revision_account_type_check
                                CHECK (account_type IN ('personal', 'shared_lab', 'test')),
  entered_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  entered_by_initials_snapshot text,
  entered_by_name_snapshot    text NOT NULL,
  idempotency_key             uuid NOT NULL
                                CONSTRAINT concrete_test_result_revision_idempotency_key UNIQUE,
  request_hash                text NOT NULL,
  transaction_id              bigint NOT NULL DEFAULT txid_current(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_test_result_revision_result_fkey FOREIGN KEY (project_id, result_id)
    REFERENCES concrete_test_result (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_test_result_revision_no_key UNIQUE (result_id, revision_no),
  -- A correction says why; initial entry never needs a reason (but may carry a note-free null).
  CONSTRAINT concrete_test_result_revision_reason_required
    CHECK (kind <> 'correction' OR reason IS NOT NULL),
  CONSTRAINT concrete_test_result_revision_initial_first
    CHECK ((kind = 'initial') = (revision_no = 1)),
  CONSTRAINT concrete_test_result_revision_entered_by_person
    CHECK (account_type = 'shared_lab' OR entered_by_user_id = account_user_id)
);
CREATE INDEX concrete_test_result_revision_entered_by_idx
  ON concrete_test_result_revision (entered_by_user_id);
CREATE INDEX concrete_test_result_revision_account_idx
  ON concrete_test_result_revision (account_user_id);

-- The credited person is never a shared account.
CREATE FUNCTION concrete_test_result_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM app_user u
               WHERE u.id = NEW.entered_by_user_id AND u.account_type = 'shared_lab') THEN
      RAISE EXCEPTION 'a test-result entry is credited to a person, never a shared account'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'concrete_test_result_revision_entered_by_check';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'concrete test-result revisions are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_revision_append_only';
END;
$$;
CREATE TRIGGER concrete_test_result_revision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_test_result_revision
  FOR EACH ROW EXECUTE FUNCTION concrete_test_result_revision_guard();
CREATE TRIGGER concrete_test_result_revision_no_truncate
  BEFORE TRUNCATE ON concrete_test_result_revision
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_test_result_revision_guard();

CREATE TRIGGER concrete_test_result_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_test_result
  FOR EACH ROW EXECUTE FUNCTION concrete_test_result_guard();
CREATE TRIGGER concrete_test_result_no_truncate
  BEFORE TRUNCATE ON concrete_test_result
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_test_result_guard();
