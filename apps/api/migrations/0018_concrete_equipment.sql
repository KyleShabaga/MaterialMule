-- MM-V2-C27: concrete equipment register (the one testing machine and the air meters) with an
-- append-only calibration history.
--
-- Confirmed (CD-44, CD-45; card C27): one testing machine, no per-test machine selector; the Lab
-- Manager keeps its make, model, last and next calibration with history. Air meters are registered
-- and assigned to technicians; a field report's air-meter ID autofills from the performing
-- technician's assigned meter. Overdue calibration or unresolved equipment issues flag the work
-- when the equipment is used; the work is still recorded (flags never block). The overdue rule uses
-- the recorded next-due date only: no calibration interval is stored or assumed anywhere.
--
-- Not here (owner inputs or later cards): the air-meter calibration procedure fields (the form is
-- not mapped yet), calibration attachments (C15 owns attachments), the due-date boundary procedure
-- (the API flags use on the due date separately from use after it), and the result-level flags
-- themselves (the field report, testing table and review cards store the evaluation with their own
-- records). Nothing here touches the concrete record tables or any storage-unit table.

CREATE TABLE concrete_equipment (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                          text NOT NULL
                                  CONSTRAINT concrete_equipment_kind_check
                                  CHECK (kind IN ('testing_machine', 'air_meter')),
  -- The ID written on the equipment (an air meter's ID on field reports). Required for air meters;
  -- optional for the single testing machine. Unique, ignoring case, among equipment not retired.
  identifier                    text
                                  CONSTRAINT concrete_equipment_identifier_check
                                  CHECK (identifier IS NULL OR length(btrim(identifier)) BETWEEN 1 AND 40),
  description                   text
                                  CONSTRAINT concrete_equipment_description_check
                                  CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 500),
  make                          text
                                  CONSTRAINT concrete_equipment_make_check
                                  CHECK (make IS NULL OR length(btrim(make)) BETWEEN 1 AND 120),
  model                         text
                                  CONSTRAINT concrete_equipment_model_check
                                  CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 120),
  -- Air meters only: the technician it is assigned to (an active personal or test account when
  -- assigned; a later disable keeps the row as it was).
  assigned_user_id              uuid REFERENCES app_user (id),
  assigned_initials_snapshot    text,
  assigned_name_snapshot        text,
  -- in_service; out_of_service = an unresolved equipment issue (flags use); retired = final.
  status                        text NOT NULL DEFAULT 'in_service'
                                  CONSTRAINT concrete_equipment_status_check
                                  CHECK (status IN ('in_service', 'out_of_service', 'retired')),
  status_note                   text
                                  CONSTRAINT concrete_equipment_status_note_check
                                  CHECK (status_note IS NULL OR length(btrim(status_note)) BETWEEN 1 AND 2000),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  created_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  created_by_initials_snapshot  text,
  created_by_name_snapshot      text NOT NULL,
  create_idempotency_key        uuid NOT NULL
                                  CONSTRAINT concrete_equipment_create_key UNIQUE,
  create_request_hash           text NOT NULL,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  updated_by_initials_snapshot  text,
  updated_by_name_snapshot      text NOT NULL,
  version                       integer NOT NULL DEFAULT 1
                                  CONSTRAINT concrete_equipment_version_check CHECK (version >= 1),
  CONSTRAINT concrete_equipment_updated_check CHECK (updated_at >= created_at),
  CONSTRAINT concrete_equipment_air_meter_identifier
    CHECK (kind <> 'air_meter' OR identifier IS NOT NULL),
  CONSTRAINT concrete_equipment_assignment_kind
    CHECK (assigned_user_id IS NULL OR kind = 'air_meter'),
  CONSTRAINT concrete_equipment_assignment_snapshot
    CHECK ((assigned_user_id IS NULL AND assigned_name_snapshot IS NULL
            AND assigned_initials_snapshot IS NULL)
        OR (assigned_user_id IS NOT NULL AND assigned_name_snapshot IS NOT NULL)),
  -- A retired meter is assigned to nobody.
  CONSTRAINT concrete_equipment_retired_unassigned
    CHECK (status <> 'retired' OR assigned_user_id IS NULL),
  -- Out of service or retired says why.
  CONSTRAINT concrete_equipment_status_note_required
    CHECK (status = 'in_service' OR status_note IS NOT NULL)
);

-- CD-44: one testing machine. A replaced machine is retired (its history stays for the reports
-- that used it) before another is registered.
CREATE UNIQUE INDEX concrete_equipment_one_testing_machine
  ON concrete_equipment (kind) WHERE kind = 'testing_machine' AND status <> 'retired';
CREATE UNIQUE INDEX concrete_equipment_identifier_key
  ON concrete_equipment (lower(btrim(identifier)))
  WHERE identifier IS NOT NULL AND status <> 'retired';
CREATE INDEX concrete_equipment_assigned_idx
  ON concrete_equipment (assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- Equipment is never deleted, never changes kind, identity or creation, steps its version by one,
-- and once retired never changes again.
CREATE FUNCTION concrete_equipment_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concrete equipment is never deleted; retire it instead'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_equipment_no_delete';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.create_idempotency_key <> OLD.create_idempotency_key
     OR NEW.create_request_hash <> OLD.create_request_hash THEN
    RAISE EXCEPTION 'concrete equipment keeps its id, kind and creation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_fixed';
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired concrete equipment never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_retired_final';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every concrete equipment change increments the version by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_version_step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_equipment_guard
  BEFORE UPDATE OR DELETE ON concrete_equipment
  FOR EACH ROW EXECUTE FUNCTION concrete_equipment_guard();

CREATE FUNCTION concrete_equipment_no_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is never truncated', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_equipment_no_truncate';
END;
$$;

CREATE TRIGGER concrete_equipment_no_truncate
  BEFORE TRUNCATE ON concrete_equipment
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_equipment_no_truncate();

-- A meter is assigned only to an active personal (or test) account: never the shared LAB account,
-- a pending or a disabled one. Checked when the assignee is set or changed, so a later disable
-- leaves the existing assignment as it was (the autofill only offers active technicians anyway).
CREATE FUNCTION concrete_equipment_assignee_active() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id)
     AND NOT EXISTS (SELECT 1 FROM app_user
                     WHERE id = NEW.assigned_user_id AND status = 'active'
                       AND account_type <> 'shared_lab') THEN
    RAISE EXCEPTION 'an air meter is assigned only to an active staff member'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_assignee_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_equipment_assignee_active
  BEFORE INSERT OR UPDATE ON concrete_equipment
  FOR EACH ROW EXECUTE FUNCTION concrete_equipment_assignee_active();

-- Calibration history: one row per recorded calibration, numbered 1, 2, 3… per equipment, never
-- overwritten or deleted (AC2). A mistaken entry is voided with a reason and stays in the history;
-- voiding is the only change a row ever takes. The entry in effect on a date is the latest
-- (calibrated_on, entry_number) entry not voided with calibrated_on on or before that date.
CREATE TABLE concrete_equipment_calibration (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id                  uuid NOT NULL REFERENCES concrete_equipment (id),
  entry_number                  integer NOT NULL
                                  CONSTRAINT concrete_equipment_calibration_entry_check
                                  CHECK (entry_number >= 1),
  calibrated_on                 date NOT NULL,
  -- As recorded on the calibration; the only input to the overdue rule.
  next_due_on                   date NOT NULL,
  -- Who performed it (a person or an outside calibration company), as written.
  performed_by                  text NOT NULL
                                  CONSTRAINT concrete_equipment_calibration_performed_by_check
                                  CHECK (length(btrim(performed_by)) BETWEEN 1 AND 200),
  -- The result as stated on the certificate or form; free text until the form is mapped.
  result                        text
                                  CONSTRAINT concrete_equipment_calibration_result_check
                                  CHECK (result IS NULL OR length(btrim(result)) BETWEEN 1 AND 2000),
  recorded_at                   timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  recorded_by_initials_snapshot text,
  recorded_by_name_snapshot     text NOT NULL,
  idempotency_key               uuid NOT NULL
                                  CONSTRAINT concrete_equipment_calibration_key UNIQUE,
  request_hash                  text NOT NULL,
  voided_at                     timestamptz,
  voided_by_user_id             uuid REFERENCES app_user (id),
  voided_by_initials_snapshot   text,
  voided_by_name_snapshot       text,
  void_reason                   text
                                  CONSTRAINT concrete_equipment_calibration_void_reason_check
                                  CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT concrete_equipment_calibration_dates CHECK (next_due_on > calibrated_on),
  CONSTRAINT concrete_equipment_calibration_number_key UNIQUE (equipment_id, entry_number),
  CONSTRAINT concrete_equipment_calibration_voided_check CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND voided_by_name_snapshot IS NULL
     AND voided_by_initials_snapshot IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL
        AND voided_by_name_snapshot IS NOT NULL AND void_reason IS NOT NULL
        AND voided_at >= recorded_at)
  )
);
CREATE INDEX concrete_equipment_calibration_current_idx
  ON concrete_equipment_calibration (equipment_id, calibrated_on DESC, entry_number DESC)
  WHERE voided_at IS NULL;

-- Entries are numbered contiguously per equipment (the service numbers them under the equipment
-- row's lock), and only for equipment that is not retired.
CREATE FUNCTION concrete_equipment_calibration_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_number <> 1 + coalesce(
       (SELECT max(entry_number) FROM concrete_equipment_calibration
        WHERE equipment_id = NEW.equipment_id), 0) THEN
    RAISE EXCEPTION 'calibration entries are numbered 1, 2, 3… per equipment'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_calibration_contiguous';
  END IF;
  IF EXISTS (SELECT 1 FROM concrete_equipment
             WHERE id = NEW.equipment_id AND status = 'retired') THEN
    RAISE EXCEPTION 'retired equipment takes no new calibration'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_calibration_retired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_equipment_calibration_insert
  BEFORE INSERT ON concrete_equipment_calibration
  FOR EACH ROW EXECUTE FUNCTION concrete_equipment_calibration_insert();

-- History is never overwritten (AC2): no delete, and the only update is a one-time void.
CREATE FUNCTION concrete_equipment_calibration_history() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'calibration history is never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_equipment_calibration_no_delete';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided calibration entry never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_calibration_history';
  END IF;
  IF NEW.id <> OLD.id OR NEW.equipment_id <> OLD.equipment_id
     OR NEW.entry_number <> OLD.entry_number OR NEW.calibrated_on <> OLD.calibrated_on
     OR NEW.next_due_on <> OLD.next_due_on OR NEW.performed_by <> OLD.performed_by
     OR NEW.result IS DISTINCT FROM OLD.result OR NEW.recorded_at <> OLD.recorded_at
     OR NEW.recorded_by_user_id <> OLD.recorded_by_user_id
     OR NEW.recorded_by_initials_snapshot IS DISTINCT FROM OLD.recorded_by_initials_snapshot
     OR NEW.recorded_by_name_snapshot <> OLD.recorded_by_name_snapshot
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'a recorded calibration entry is never overwritten; void it and record another'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_equipment_calibration_history';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_equipment_calibration_history
  BEFORE UPDATE OR DELETE ON concrete_equipment_calibration
  FOR EACH ROW EXECUTE FUNCTION concrete_equipment_calibration_history();

CREATE TRIGGER concrete_equipment_calibration_no_truncate
  BEFORE TRUNCATE ON concrete_equipment_calibration
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_equipment_no_truncate();
