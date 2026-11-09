-- MM-V2-C26: HOLD management, bulk actions and concrete specimen disposal. Adds four tables and
-- replaces the C05/C22 specimen age guard; changes no existing row.
--
-- Two kinds of hold (combined plan, "HOLD retention and disposition"):
--   ordinary  a spare specimen assigned HOLD (C05): 56 days from casting or the project's number.
--             Released by the lead or any Lab Manager (concrete_ordinary_hold.manage, role alone)
--             either by scheduling a test age or by authorizing disposal.
--   failed    a tested specimen held after a failed result (C25 places it; nothing here does).
--             Released only by the lead or a Lab Manager with the project's concrete grant
--             (concrete_hold.manage), by authorizing disposal. Reaching an ordinary HOLD date never
--             releases it.
-- Reaching a HOLD expiry only flags the specimen for review (C22): nothing here runs on a date.
--
-- Disposal is two separate records on one row per specimen: the authorization (who, when, why,
-- which kind of hold it released) and, later, the actual removal (date/time, performing person,
-- recording account). Authorized-but-not-removed stays distinct from disposed; neither deletes or
-- changes any specimen, test or report record. Storage-unit retention and disposal (MM-T29/T30,
-- MISC-13) are untouched: none of their rules apply here.
--
-- Bulk commands are one row in concrete_hold_command (idempotency) and one history row per
-- specimen, so every specimen keeps its own history (card AC1).

-- ---------------------------------------------------------------------------------------------
-- Command ledger
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_hold_command (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   uuid NOT NULL UNIQUE,
  kind              text NOT NULL
                      CONSTRAINT concrete_hold_command_kind_check
                      CHECK (kind IN ('schedule_test', 'authorize_disposal', 'record_disposal')),
  request_hash      text NOT NULL,
  account_user_id   uuid NOT NULL REFERENCES app_user (id),
  specimen_ids      uuid[] NOT NULL
                      CONSTRAINT concrete_hold_command_specimens_check
                      CHECK (cardinality(specimen_ids) BETWEEN 1 AND 200),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concrete_hold_command_account_idx ON concrete_hold_command (account_user_id);

-- ---------------------------------------------------------------------------------------------
-- Failed-specimen hold (placed by C25)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_specimen_failure_hold (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL,
  specimen_id              uuid NOT NULL
                             CONSTRAINT concrete_specimen_failure_hold_specimen_key UNIQUE,
  reason                   text NOT NULL
                             CONSTRAINT concrete_specimen_failure_hold_reason_check
                             CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  placed_by_user_id        uuid NOT NULL REFERENCES app_user (id),
  placed_by_name_snapshot  text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_specimen_failure_hold_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE
);
CREATE INDEX concrete_specimen_failure_hold_project_idx
  ON concrete_specimen_failure_hold (project_id);

-- ---------------------------------------------------------------------------------------------
-- Ordinary HOLD → scheduled test age
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_specimen_hold_schedule (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                      uuid NOT NULL,
  specimen_id                     uuid NOT NULL,
  command_id                      uuid NOT NULL REFERENCES concrete_hold_command (id),
  previous_hold_expires_on        date NOT NULL,
  new_age                         text NOT NULL
                                    CONSTRAINT concrete_specimen_hold_schedule_new_age_check
                                    CHECK (new_age ~ '^[1-9][0-9]{0,2}$'),
  new_target_date                 date NOT NULL,
  reason                          text NOT NULL
                                    CONSTRAINT concrete_specimen_hold_schedule_reason_check
                                    CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  scheduled_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  scheduled_by_initials_snapshot  text,
  scheduled_by_name_snapshot      text NOT NULL,
  -- The transaction that made the change, so the specimen's age guard can match it.
  transaction_id                  bigint NOT NULL DEFAULT txid_current(),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_specimen_hold_schedule_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE
);
CREATE INDEX concrete_specimen_hold_schedule_specimen_idx
  ON concrete_specimen_hold_schedule (specimen_id, created_at);
CREATE INDEX concrete_specimen_hold_schedule_command_idx
  ON concrete_specimen_hold_schedule (command_id);

-- ---------------------------------------------------------------------------------------------
-- Disposal: authorization, then actual removal
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_specimen_disposal (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                        uuid NOT NULL,
  specimen_id                       uuid NOT NULL
                                      CONSTRAINT concrete_specimen_disposal_specimen_key UNIQUE,
  -- Which hold the authorization released.
  hold_kind                         text NOT NULL
                                      CONSTRAINT concrete_specimen_disposal_hold_kind_check
                                      CHECK (hold_kind IN ('ordinary', 'failed')),
  authorization_command_id          uuid NOT NULL REFERENCES concrete_hold_command (id),
  authorization_reason              text NOT NULL
                                      CONSTRAINT concrete_specimen_disposal_reason_check
                                      CHECK (length(btrim(authorization_reason)) BETWEEN 1 AND 2000),
  authorized_by_user_id             uuid NOT NULL REFERENCES app_user (id),
  authorized_by_initials_snapshot   text,
  authorized_by_name_snapshot       text NOT NULL,
  authorized_at                     timestamptz NOT NULL DEFAULT now(),
  -- Actual removal (lab staff), recorded once, later.
  disposal_command_id               uuid REFERENCES concrete_hold_command (id),
  disposed_at                       timestamptz,
  disposed_by_user_id               uuid REFERENCES app_user (id),
  disposed_by_initials_snapshot     text,
  disposed_by_name_snapshot         text,
  disposal_recorded_by_user_id      uuid REFERENCES app_user (id),
  disposal_recorded_at              timestamptz,
  CONSTRAINT concrete_specimen_disposal_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_specimen_disposal_removal_shape CHECK (
    (disposal_command_id IS NULL AND disposed_at IS NULL AND disposed_by_user_id IS NULL
       AND disposed_by_name_snapshot IS NULL AND disposed_by_initials_snapshot IS NULL
       AND disposal_recorded_by_user_id IS NULL AND disposal_recorded_at IS NULL)
    OR (disposal_command_id IS NOT NULL AND disposed_at IS NOT NULL
        AND disposed_by_user_id IS NOT NULL AND disposed_by_name_snapshot IS NOT NULL
        AND disposal_recorded_by_user_id IS NOT NULL AND disposal_recorded_at IS NOT NULL)
  ),
  -- Removed after it was authorized (to the minute the person enters), and not in the future.
  CONSTRAINT concrete_specimen_disposal_removal_time CHECK (
    disposed_at IS NULL
    OR (disposed_at >= date_trunc('minute', authorized_at)
        AND disposed_at <= disposal_recorded_at + interval '5 minutes')
  )
);
CREATE INDEX concrete_specimen_disposal_ready_idx
  ON concrete_specimen_disposal (authorized_at) WHERE disposed_at IS NULL;
CREATE INDEX concrete_specimen_disposal_project_idx ON concrete_specimen_disposal (project_id);

-- An authorization names the hold it releases, and that hold must be the specimen's: an ordinary
-- release needs a specimen assigned HOLD, a failed release a failed-specimen hold.
CREATE FUNCTION concrete_specimen_disposal_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hold_kind = 'ordinary' AND NOT EXISTS (
       SELECT 1 FROM concrete_specimen WHERE id = NEW.specimen_id AND assigned_age = 'HOLD') THEN
    RAISE EXCEPTION 'specimen % is not on an ordinary HOLD', NEW.specimen_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_disposal_hold_matches';
  END IF;
  IF NEW.hold_kind = 'failed' AND NOT EXISTS (
       SELECT 1 FROM concrete_specimen_failure_hold WHERE specimen_id = NEW.specimen_id) THEN
    RAISE EXCEPTION 'specimen % has no failed-specimen hold', NEW.specimen_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_disposal_hold_matches';
  END IF;
  IF NEW.disposed_at IS NOT NULL THEN
    RAISE EXCEPTION 'disposal of % is authorized before it is recorded', NEW.specimen_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_disposal_authorize_first';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_disposal_insert_guard
  BEFORE INSERT ON concrete_specimen_disposal
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_disposal_insert_guard();

-- The authorization never changes; the removal is written once, from nothing to complete. Only a
-- project correction cascading from the specimen changes anything else. Never deleted.
CREATE FUNCTION concrete_specimen_disposal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  removal text[] := ARRAY['disposal_command_id', 'disposed_at', 'disposed_by_user_id',
                          'disposed_by_initials_snapshot', 'disposed_by_name_snapshot',
                          'disposal_recorded_by_user_id', 'disposal_recorded_at'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
      RETURN NEW;
    END IF;
    IF OLD.disposed_at IS NULL AND NEW.disposed_at IS NOT NULL
       AND (to_jsonb(NEW) - removal) = (to_jsonb(OLD) - removal) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'concrete specimen disposal records keep their authorization and removal'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_disposal_append_only';
END;
$$;
CREATE TRIGGER concrete_specimen_disposal_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_disposal
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_disposal_guard();
CREATE TRIGGER concrete_specimen_disposal_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_disposal
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_disposal_guard();

-- ---------------------------------------------------------------------------------------------
-- Append-only history
-- ---------------------------------------------------------------------------------------------

-- Commands, failure holds and HOLD schedules are append-only. A failure hold or HOLD schedule
-- changes only by a project correction cascading from the specimen; a command never changes.
CREATE FUNCTION concrete_hold_command_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete_hold_command is append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_hold_command_append_only';
END;
$$;
CREATE TRIGGER concrete_hold_command_guard
  BEFORE UPDATE OR DELETE ON concrete_hold_command
  FOR EACH ROW EXECUTE FUNCTION concrete_hold_command_guard();
CREATE TRIGGER concrete_hold_command_no_truncate
  BEFORE TRUNCATE ON concrete_hold_command
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_hold_command_guard();

CREATE FUNCTION concrete_hold_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$;
CREATE TRIGGER concrete_specimen_failure_hold_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_failure_hold
  FOR EACH ROW EXECUTE FUNCTION concrete_hold_history_guard();
CREATE TRIGGER concrete_specimen_failure_hold_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_failure_hold
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_hold_history_guard();
CREATE TRIGGER concrete_specimen_hold_schedule_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_hold_schedule
  FOR EACH ROW EXECUTE FUNCTION concrete_hold_history_guard();
CREATE TRIGGER concrete_specimen_hold_schedule_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_hold_schedule
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_hold_history_guard();

-- ---------------------------------------------------------------------------------------------
-- Specimen age guard (replaces C22's)
-- ---------------------------------------------------------------------------------------------

-- C22's guard, widened by exactly one more path and narrowed by one rule:
--   * a numbered set's specimen changes its age only with a reschedule (C22) or, from HOLD, a
--     HOLD schedule (C26) recorded in the same transaction for exactly that change;
--   * no specimen with a disposal authorization changes its age at all (it is leaving the lab).
CREATE OR REPLACE FUNCTION concrete_specimen_age_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_age IS DISTINCT FROM OLD.assigned_age THEN
    IF EXISTS (SELECT 1 FROM concrete_specimen_disposal d WHERE d.specimen_id = OLD.id) THEN
      RAISE EXCEPTION 'specimen % is authorized for disposal and keeps its assigned age', OLD.id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_age_disposal';
    END IF;
    IF EXISTS (SELECT 1 FROM concrete_specimen_set s
               WHERE s.id = OLD.set_id AND s.permanent_number IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM concrete_specimen_reschedule r
         WHERE r.specimen_id = OLD.id AND r.transaction_id = txid_current()
           AND r.previous_age = OLD.assigned_age AND r.new_age = NEW.assigned_age
       )
       AND NOT (
         OLD.assigned_age = 'HOLD' AND EXISTS (
           SELECT 1 FROM concrete_specimen_hold_schedule h
           WHERE h.specimen_id = OLD.id AND h.transaction_id = txid_current()
             AND h.new_age = NEW.assigned_age
         )
       ) THEN
      RAISE EXCEPTION 'specimen % keeps its assigned age in a numbered set', OLD.id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_age_fixed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
