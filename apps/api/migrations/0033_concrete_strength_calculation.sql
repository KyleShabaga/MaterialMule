-- MM-V2-C24: concrete strength calculation with versioned methods, reviewer exclusion from a
-- strength test. PROVISIONAL method P1 ("V2 Concrete — Provisional report designs (G2,
-- 2026-11-09)", section 6); the office worksheet becomes a later method version.
--
-- 1. concrete_calculation_method: one row per (method, version). P1 is seeded by
--    seed/reference.sql (provisional). Exactly one version per method is current (used for new
--    attempts). Rows are never deleted and their identity and wording never change; only which
--    version is current may move.
-- 2. concrete_test_result: C07 held calculation_method / calculation_method_version empty. They
--    now name the method version the attempt is calculated with, fixed when the attempt is created
--    (AC2): changing it needs a revision of kind 'recalculation' (with a reason) in the same
--    transaction. The calculated values sit beside the readings, raw and rounded, and exist
--    exactly when the entry is complete. Values come from the API's shared calculator
--    (packages/shared concrete-strength.ts); this file only keeps them consistent.
--    Attempts saved before C24 keep a NULL method until their next save (no backfill: no
--    calculator in SQL, and V2 holds no production results yet).
-- 3. concrete_strength_exclusion: append-only exclude / reinstate events per specimen, each with
--    a reason and the person. Like a result change, it is refused while the specimen is on a
--    submitted, reviewed or issued strength report version (C39's lock).

CREATE TABLE concrete_calculation_method (
  method        text NOT NULL
                  CONSTRAINT concrete_calculation_method_method_check
                  CHECK (method IN ('compressive_strength')),
  version       text NOT NULL
                  CONSTRAINT concrete_calculation_method_version_check
                  CHECK (version ~ '^[A-Z][A-Z0-9.-]{0,19}$'),
  name          text NOT NULL
                  CONSTRAINT concrete_calculation_method_name_check
                  CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  provisional   boolean NOT NULL,
  -- Where the rules come from (the design page section, later the worksheet).
  source        text NOT NULL
                  CONSTRAINT concrete_calculation_method_source_check
                  CHECK (length(btrim(source)) BETWEEN 1 AND 500),
  is_current    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_calculation_method_pkey PRIMARY KEY (method, version)
);
CREATE UNIQUE INDEX concrete_calculation_method_one_current
  ON concrete_calculation_method (method) WHERE is_current;

CREATE FUNCTION concrete_calculation_method_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'calculation methods are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_calculation_method_kept';
  END IF;
  IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current') THEN
    RAISE EXCEPTION 'a calculation method version never changes; add a new version'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_calculation_method_fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_calculation_method_guard
  BEFORE UPDATE OR DELETE ON concrete_calculation_method
  FOR EACH ROW EXECUTE FUNCTION concrete_calculation_method_guard();
CREATE TRIGGER concrete_calculation_method_no_truncate
  BEFORE TRUNCATE ON concrete_calculation_method
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_calculation_method_guard();

-- ---- Results ----------------------------------------------------------------------------------

ALTER TABLE concrete_test_result
  DROP CONSTRAINT concrete_test_result_method_gated,
  ADD COLUMN calc_mean_diameter      numeric,
  ADD COLUMN calc_mean_height        numeric,
  ADD COLUMN calc_area_raw           numeric,
  ADD COLUMN calc_area               numeric,
  ADD COLUMN calc_ld_ratio           numeric,
  ADD COLUMN calc_correction_factor  numeric,
  ADD COLUMN calc_strength_raw       numeric,
  ADD COLUMN calc_strength           numeric,
  ADD COLUMN calc_flags              text[] NOT NULL DEFAULT '{}',
  ADD COLUMN calculated_at           timestamptz,
  -- Still unused: the report link stays empty (C39 links results through snapshots).
  ADD CONSTRAINT concrete_test_result_report_version_unused CHECK (report_version_id IS NULL),
  ADD CONSTRAINT concrete_test_result_method_pair CHECK (
    (calculation_method IS NULL) = (calculation_method_version IS NULL)
  ),
  ADD CONSTRAINT concrete_test_result_method_fkey
    FOREIGN KEY (calculation_method, calculation_method_version)
    REFERENCES concrete_calculation_method (method, version),
  -- The calculated values come together, only with a method, and exactly for a complete entry.
  ADD CONSTRAINT concrete_test_result_calc_shape CHECK (
    (calc_area_raw IS NULL) = (calc_mean_diameter IS NULL)
    AND (calc_area_raw IS NULL) = (calc_mean_height IS NULL)
    AND (calc_area_raw IS NULL) = (calc_area IS NULL)
    AND (calc_area_raw IS NULL) = (calc_ld_ratio IS NULL)
    AND (calc_area_raw IS NULL) = (calculated_at IS NULL)
    AND (calc_strength_raw IS NULL) = (calc_strength IS NULL)
    AND (calc_strength_raw IS NULL) = (calc_correction_factor IS NULL)
    AND (calc_strength_raw IS NULL OR calc_area_raw IS NOT NULL)
    AND (calc_area_raw IS NULL OR calculation_method IS NOT NULL)
    AND (calc_area_raw IS NULL OR (calc_area_raw > 0 AND calc_ld_ratio > 0))
    AND (calc_strength_raw IS NULL OR (calc_strength_raw > 0 AND calc_correction_factor > 0))
    -- The printed values are the rounded raw ones (1 mm², 0.1 MPa).
    AND (calc_area IS NULL OR calc_area = round(calc_area))
    AND (calc_strength IS NULL OR calc_strength = round(calc_strength, 1))
  ),
  ADD CONSTRAINT concrete_test_result_calc_complete CHECK (
    calculation_method IS NULL
    OR (calc_area_raw IS NOT NULL) = (
      tested_on IS NOT NULL AND tester_user_id IS NOT NULL AND max_load IS NOT NULL
      AND cardinality(height_readings) > 0 AND cardinality(diameter_readings) > 0)
  ),
  ADD CONSTRAINT concrete_test_result_calc_flags_check CHECK (
    calc_flags <@ ARRAY['diameter_spread', 'ld_below_minimum', 'ld_out_of_range']::text[]
    AND (cardinality(calc_flags) = 0 OR calc_area_raw IS NOT NULL)
  );
CREATE INDEX concrete_test_result_method_idx
  ON concrete_test_result (calculation_method, calculation_method_version)
  WHERE calculation_method IS NOT NULL;

ALTER TABLE concrete_test_result_revision
  DROP CONSTRAINT concrete_test_result_revision_kind_check,
  ADD CONSTRAINT concrete_test_result_revision_kind_check
    CHECK (kind IN ('initial', 'entry', 'correction', 'recalculation')),
  DROP CONSTRAINT concrete_test_result_revision_reason_required,
  ADD CONSTRAINT concrete_test_result_revision_reason_required
    CHECK (kind NOT IN ('correction', 'recalculation') OR reason IS NOT NULL);

-- C07's guard, plus: once set, the method version changes only with a 'recalculation' revision
-- of this save (AC2), and is never cleared.
CREATE OR REPLACE FUNCTION concrete_test_result_guard() RETURNS trigger
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
  -- MM-V2-C24 (AC2): the method version an attempt was calculated with stays until deliberately
  -- recalculated.
  IF TG_OP = 'UPDATE' AND OLD.calculation_method_version IS NOT NULL
     AND (NEW.calculation_method IS DISTINCT FROM OLD.calculation_method
          OR NEW.calculation_method_version IS DISTINCT FROM OLD.calculation_method_version)
     AND (NEW.calculation_method_version IS NULL OR NOT EXISTS (
       SELECT 1 FROM concrete_test_result_revision r
       WHERE r.result_id = OLD.id AND r.revision_no = NEW.version AND r.kind = 'recalculation'
         AND r.transaction_id = txid_current()
     )) THEN
    RAISE EXCEPTION 'test result % keeps its calculation method until recalculated', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_method_kept';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Reviewer exclusion -----------------------------------------------------------------------

CREATE TABLE concrete_strength_exclusion (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL,
  specimen_id              uuid NOT NULL,
  -- 1, 2, 3 … per specimen; odd = exclude, even = reinstate (they alternate from exclude).
  sequence_no              integer NOT NULL
                             CONSTRAINT concrete_strength_exclusion_sequence_check
                             CHECK (sequence_no >= 1),
  action                   text NOT NULL
                             CONSTRAINT concrete_strength_exclusion_action_check
                             CHECK (action IN ('exclude', 'reinstate')),
  reason                   text NOT NULL
                             CONSTRAINT concrete_strength_exclusion_reason_check
                             CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  user_id                  uuid NOT NULL REFERENCES app_user (id),
  user_initials_snapshot   text,
  user_name_snapshot       text NOT NULL,
  idempotency_key          uuid NOT NULL
                             CONSTRAINT concrete_strength_exclusion_idempotency_key UNIQUE,
  request_hash             text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_strength_exclusion_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_strength_exclusion_sequence_key UNIQUE (specimen_id, sequence_no),
  CONSTRAINT concrete_strength_exclusion_alternates
    CHECK ((action = 'exclude') = (sequence_no % 2 = 1))
);
CREATE INDEX concrete_strength_exclusion_user_idx ON concrete_strength_exclusion (user_id);

CREATE FUNCTION concrete_strength_exclusion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM app_user u
               WHERE u.id = NEW.user_id AND u.account_type = 'shared_lab') THEN
      RAISE EXCEPTION 'an exclusion is made by a person, never a shared account'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_strength_exclusion_person';
    END IF;
    IF NEW.sequence_no > 1 AND NOT EXISTS (
         SELECT 1 FROM concrete_strength_exclusion e
         WHERE e.specimen_id = NEW.specimen_id AND e.sequence_no = NEW.sequence_no - 1) THEN
      RAISE EXCEPTION 'exclusion events are numbered without gaps'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_strength_exclusion_sequence';
    END IF;
    -- C39's lock: not while a submitted, reviewed or issued version reports the specimen.
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
      RAISE EXCEPTION 'this specimen is on a submitted or issued strength report'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_strength_exclusion_reported';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'strength exclusions are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_strength_exclusion_append_only';
END;
$$;
CREATE TRIGGER concrete_strength_exclusion_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_strength_exclusion
  FOR EACH ROW EXECUTE FUNCTION concrete_strength_exclusion_guard();
CREATE TRIGGER concrete_strength_exclusion_no_truncate
  BEFORE TRUNCATE ON concrete_strength_exclusion
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_strength_exclusion_guard();
