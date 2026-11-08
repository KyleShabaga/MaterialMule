-- MM-V2-C05: specimen-set and specimen detail, saved schedule snapshots, specimen target dates and
-- HOLD expiry, Void metadata, casting-time corrections and the set command ledger. Adds columns to
-- C01's concrete_specimen_set / concrete_specimen; repurposes none (docs/concrete.md "Field
-- ownership"). No number allocation (C18), device codes (C12) or Void action (C18) here.
--
-- One specimen per populated test-age / HOLD entry (card §2): the specimen rows ARE the count, so
-- no count column exists anywhere. Letters A–Z (C01) cap a set at 26.
--
-- Casting time, material and "Specimens cast" live on the field report (C04: cast_at, material,
-- specimens_cast); a set is cast from that report's load. Each specimen stores its assigned age
-- and the date that follows from it (target date for an age in days, HOLD expiry for HOLD), kept
-- in step with the report's casting time by the triggers below, so a stored date can never
-- disagree with the casting time and the saved age. Weekend and holiday targets are kept as they
-- fall (combined plan, "Scheduled test dates"); nothing is shifted, tested or disposed of here.
--
-- Saved schedule snapshot (AC4): the defaults resolved when the set was created (mix, else
-- project settings, else the lab default 7/28/28/HOLD) and the HOLD duration (project, else 56
-- days) are copied onto the set and never change afterwards; later settings or mix edits never
-- recalculate an existing set.

ALTER TABLE concrete_specimen_set
  -- Shape of the specimens: concrete cylinders; grout cubes and beams are kept for later cards
  -- (card §2) without their workflows.
  ADD COLUMN specimen_type text NOT NULL DEFAULT 'cylinder'
    CONSTRAINT concrete_specimen_set_specimen_type_check
    CHECK (specimen_type IN ('cylinder', 'cube', 'beam')),
  -- Mould size in mm as written (e.g. 150x300, the concrete default). NULL = not entered.
  ADD COLUMN mould_size text
    CONSTRAINT concrete_specimen_set_mould_size_check
    CHECK (mould_size ~ '^[1-9][0-9]{1,2}x[1-9][0-9]{1,2}$'),
  -- The account that created the set (authority; may be LAB) and the performing person.
  ADD COLUMN created_by_user_id uuid REFERENCES app_user (id),
  ADD COLUMN technician_user_id uuid REFERENCES app_user (id),
  -- Saved schedule snapshot: what the defaults were when the set was created, and where they came
  -- from. All or none (a set inserted before C05 or imported later may have none).
  ADD COLUMN default_ages text[]
    CONSTRAINT concrete_specimen_set_default_ages_check
    CHECK (concrete_specimen_ages_valid(default_ages)),
  ADD COLUMN default_ages_source text
    CONSTRAINT concrete_specimen_set_default_ages_source_check
    CHECK (default_ages_source IN ('lab_default', 'project', 'mix')),
  ADD COLUMN default_ages_mix_revision_id uuid REFERENCES concrete_mix_revision (id),
  ADD COLUMN hold_duration_days integer
    CONSTRAINT concrete_specimen_set_hold_duration_check CHECK (hold_duration_days BETWEEN 1 AND 999),
  ADD COLUMN hold_duration_source text
    CONSTRAINT concrete_specimen_set_hold_duration_source_check
    CHECK (hold_duration_source IN ('lab_default', 'project')),
  -- Void (CD-08): a numbered set is never deleted; C18 records its Void here. All or none.
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_user_id uuid REFERENCES app_user (id),
  ADD COLUMN void_reason text
    CONSTRAINT concrete_specimen_set_void_reason_check CHECK (length(btrim(void_reason)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT concrete_specimen_set_snapshot_shape CHECK (
    (default_ages IS NULL AND default_ages_source IS NULL AND default_ages_mix_revision_id IS NULL
       AND hold_duration_days IS NULL AND hold_duration_source IS NULL)
    OR (default_ages IS NOT NULL AND default_ages_source IS NOT NULL
        AND hold_duration_days IS NOT NULL AND hold_duration_source IS NOT NULL
        AND (default_ages_source = 'mix') = (default_ages_mix_revision_id IS NOT NULL))
  ),
  ADD CONSTRAINT concrete_specimen_set_void_shape CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL
        AND permanent_number IS NOT NULL)
  );

CREATE INDEX concrete_specimen_set_created_by_idx ON concrete_specimen_set (created_by_user_id);
CREATE INDEX concrete_specimen_set_technician_idx ON concrete_specimen_set (technician_user_id);
CREATE INDEX concrete_specimen_set_mix_revision_idx
  ON concrete_specimen_set (default_ages_mix_revision_id) WHERE default_ages_mix_revision_id IS NOT NULL;
CREATE INDEX concrete_specimen_set_voided_by_idx
  ON concrete_specimen_set (voided_by_user_id) WHERE voided_by_user_id IS NOT NULL;

-- The technician credited with a set is a person (as C01's report technician), checked when set.
CREATE FUNCTION concrete_specimen_set_technician_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.technician_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.technician_user_id IS DISTINCT FROM OLD.technician_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM app_user u
       WHERE u.id = NEW.technician_user_id AND u.status = 'active'
         AND u.account_type IN ('personal', 'test')
     ) THEN
    RAISE EXCEPTION 'a concrete technician must be an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_set_technician_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_set_technician_check
  BEFORE INSERT OR UPDATE OF technician_user_id ON concrete_specimen_set
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_set_technician_check();

-- A saved snapshot never changes (AC4), and a Void is final: once recorded it never changes or
-- clears. The creating account never changes.
CREATE FUNCTION concrete_specimen_set_detail_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.default_ages IS NOT NULL AND (
       NEW.default_ages IS DISTINCT FROM OLD.default_ages
       OR NEW.default_ages_source IS DISTINCT FROM OLD.default_ages_source
       OR NEW.default_ages_mix_revision_id IS DISTINCT FROM OLD.default_ages_mix_revision_id
       OR NEW.hold_duration_days IS DISTINCT FROM OLD.hold_duration_days
       OR NEW.hold_duration_source IS DISTINCT FROM OLD.hold_duration_source) THEN
    RAISE EXCEPTION 'set % keeps its saved schedule snapshot', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_set_snapshot_fixed';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (
       NEW.voided_at IS DISTINCT FROM OLD.voided_at
       OR NEW.voided_by_user_id IS DISTINCT FROM OLD.voided_by_user_id
       OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'set % stays Void', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_set_void_fixed';
  END IF;
  IF OLD.created_by_user_id IS NOT NULL
     AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'set % keeps its creating account', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_set_creator_fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_set_detail_guard
  BEFORE UPDATE ON concrete_specimen_set
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_set_detail_guard();

-- ---------------------------------------------------------------------------------------------
-- Specimen assignment and dates
-- ---------------------------------------------------------------------------------------------

ALTER TABLE concrete_specimen
  -- Days from casting (1–999) or HOLD: one entry of the set's schedule. Repeats are separate
  -- specimens (7/28/28/HOLD is four specimens).
  ADD COLUMN assigned_age text
    CONSTRAINT concrete_specimen_assigned_age_check CHECK (assigned_age ~ '^(HOLD|[1-9][0-9]{0,2})$'),
  -- Derived from the report's casting time (America/Edmonton calendar date) by the trigger below:
  -- the target date for an age in days, the HOLD expiry for HOLD. NULL while casting is unknown.
  ADD COLUMN target_date date,
  ADD COLUMN hold_expires_on date,
  ADD CONSTRAINT concrete_specimen_date_kind CHECK (
    (assigned_age = 'HOLD' OR hold_expires_on IS NULL)
    AND (assigned_age <> 'HOLD' OR target_date IS NULL)
  );
-- Every specimen written from now on names its age. A row that existed before C05 (no route wrote
-- any) keeps NULL, never a guessed age: the check is NOT VALID, so it binds new and changed rows.
ALTER TABLE concrete_specimen
  ADD CONSTRAINT concrete_specimen_assigned_age_required CHECK (assigned_age IS NOT NULL) NOT VALID;

CREATE INDEX concrete_specimen_target_date_idx
  ON concrete_specimen (project_id, target_date) WHERE target_date IS NOT NULL;
CREATE INDEX concrete_specimen_hold_expires_idx
  ON concrete_specimen (project_id, hold_expires_on) WHERE hold_expires_on IS NOT NULL;

-- The calendar date a casting time falls on, in the lab's time zone (CLAUDE.md: America/Edmonton,
-- as storage-unit years). STABLE: time-zone rules can change.
CREATE FUNCTION concrete_casting_date(cast_at timestamptz) RETURNS date
  LANGUAGE sql STABLE STRICT AS $$
    SELECT (cast_at AT TIME ZONE 'America/Edmonton')::date
  $$;

-- A specimen's dates always follow its report's casting time, its age and its set's saved HOLD
-- duration. A specimen that has casting time but no HOLD duration (a pre-C05 row) keeps a NULL
-- HOLD expiry.
CREATE FUNCTION concrete_specimen_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  casting date;
  hold_days integer;
BEGIN
  SELECT concrete_casting_date(r.cast_at), s.hold_duration_days INTO casting, hold_days
  FROM concrete_specimen_set s
  JOIN concrete_field_report r ON r.id = s.field_report_id
  WHERE s.id = NEW.set_id;
  IF NEW.assigned_age = 'HOLD' THEN
    NEW.target_date := NULL;
    NEW.hold_expires_on := casting + hold_days;
  ELSE
    NEW.target_date := casting + NEW.assigned_age::integer;
    NEW.hold_expires_on := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_dates
  BEFORE INSERT OR UPDATE ON concrete_specimen
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_dates();

-- A specimen of a numbered set keeps its assigned age: changing it is a reschedule (C22, with
-- authority and history), never a draft edit.
CREATE FUNCTION concrete_specimen_age_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_age IS DISTINCT FROM OLD.assigned_age
     AND EXISTS (SELECT 1 FROM concrete_specimen_set s
                 WHERE s.id = OLD.set_id AND s.permanent_number IS NOT NULL) THEN
    RAISE EXCEPTION 'specimen % keeps its assigned age in a numbered set', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_age_fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_age_guard
  BEFORE UPDATE OF assigned_age ON concrete_specimen
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_age_guard();

-- ---------------------------------------------------------------------------------------------
-- Casting-time corrections (AC5)
-- ---------------------------------------------------------------------------------------------

-- Once a report has a numbered set, its casting time changes only through a recorded correction
-- (who, when, why, the dependent-date effects confirmed). The issued set IDs never change, even
-- when the corrected casting year differs from the ID's YY (combined plan §6). Append-only.
CREATE TABLE concrete_casting_correction (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL,
  field_report_id               uuid NOT NULL,
  previous_cast_at              timestamptz,
  new_cast_at                   timestamptz NOT NULL,
  reason                        text NOT NULL
                                  CONSTRAINT concrete_casting_correction_reason_check
                                  CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  -- The dependent dates as confirmed: [{specimenId, before, after}] (the API's preview).
  effects                       jsonb NOT NULL
                                  CONSTRAINT concrete_casting_correction_effects_check
                                  CHECK (jsonb_typeof(effects) = 'array'),
  corrected_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  corrected_by_initials_snapshot text,
  corrected_by_name_snapshot    text NOT NULL,
  idempotency_key               uuid NOT NULL UNIQUE,
  request_hash                  text NOT NULL,
  -- The transaction that made the correction, so the report trigger can match it.
  transaction_id                bigint NOT NULL DEFAULT txid_current(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_casting_correction_report_fkey FOREIGN KEY (project_id, field_report_id)
    REFERENCES concrete_field_report (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_casting_correction_changes CHECK (previous_cast_at IS DISTINCT FROM new_cast_at)
);
CREATE INDEX concrete_casting_correction_report_idx
  ON concrete_casting_correction (field_report_id, created_at);
CREATE INDEX concrete_casting_correction_user_idx ON concrete_casting_correction (corrected_by_user_id);

CREATE FUNCTION concrete_casting_correction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A project correction of the report cascades here; nothing else changes a correction.
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'concrete casting corrections are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_casting_correction_append_only';
END;
$$;
CREATE TRIGGER concrete_casting_correction_guard
  BEFORE UPDATE OR DELETE ON concrete_casting_correction
  FOR EACH ROW EXECUTE FUNCTION concrete_casting_correction_guard();
CREATE TRIGGER concrete_casting_correction_no_truncate
  BEFORE TRUNCATE ON concrete_casting_correction
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_casting_correction_guard();

-- A report with a numbered set changes casting time only with a correction recorded in the same
-- transaction for exactly that change.
CREATE FUNCTION concrete_field_report_casting_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cast_at IS DISTINCT FROM OLD.cast_at
     AND EXISTS (SELECT 1 FROM concrete_specimen_set s
                 WHERE s.field_report_id = OLD.id AND s.permanent_number IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM concrete_casting_correction c
       WHERE c.field_report_id = OLD.id AND c.transaction_id = txid_current()
         AND c.previous_cast_at IS NOT DISTINCT FROM OLD.cast_at
         AND c.new_cast_at = NEW.cast_at
     ) THEN
    RAISE EXCEPTION 'report % has a numbered set: correct its casting time with a reason', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_casting_correction_required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_report_casting_guard
  BEFORE UPDATE OF cast_at ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_casting_guard();

-- After any casting-time change, the report's specimens' dates follow (the BEFORE trigger on
-- concrete_specimen recomputes them); ages and letters are untouched.
CREATE FUNCTION concrete_field_report_casting_dates() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cast_at IS DISTINCT FROM OLD.cast_at THEN
    UPDATE concrete_specimen sp SET target_date = sp.target_date
    FROM concrete_specimen_set s
    WHERE s.id = sp.set_id AND s.field_report_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER concrete_field_report_casting_dates
  AFTER UPDATE OF cast_at ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_casting_dates();

-- ---------------------------------------------------------------------------------------------
-- Exactly-once set commands
-- ---------------------------------------------------------------------------------------------

-- create / save / discard: a retried request with the same key and body returns the result as it
-- stands without a second version or audit event; the same key for a different request is
-- refused (409 idempotency_key_reused). A discarded set is gone, so set_id has no foreign key.
CREATE TABLE concrete_specimen_set_command (
  idempotency_key  uuid PRIMARY KEY,
  field_report_id  uuid NOT NULL REFERENCES concrete_field_report (id),
  set_id           uuid NOT NULL,
  kind             text NOT NULL
                     CONSTRAINT concrete_specimen_set_command_kind_check
                     CHECK (kind IN ('create', 'save', 'discard')),
  request_hash     text NOT NULL,
  user_id          uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concrete_specimen_set_command_report_idx ON concrete_specimen_set_command (field_report_id);
CREATE INDEX concrete_specimen_set_command_set_idx ON concrete_specimen_set_command (set_id);
CREATE INDEX concrete_specimen_set_command_user_idx ON concrete_specimen_set_command (user_id);

CREATE FUNCTION concrete_specimen_set_command_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete specimen set commands are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_set_command_append_only';
END;
$$;
CREATE TRIGGER concrete_specimen_set_command_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_set_command
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_set_command_guard();
