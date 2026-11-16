-- STRATA-121: Hold until a date from Breaks. A scheduled specimen (an age in days, numbered set)
-- can be put on an ordinary HOLD until a chosen calendar date, with a reason, by the lead or any
-- Lab Manager (concrete_ordinary_hold.manage, as for every ordinary HOLD action). Adds one column
-- and one history table, widens the HOLD command ledger and the specimen age guard by exactly one
-- path, and teaches the specimen dates trigger the chosen date. Changes no existing row.
--
-- * concrete_specimen.hold_until: the chosen hold-until date. Set only by this command (a history
--   row for exactly that date in the same transaction), only while the specimen is on HOLD; the
--   dates trigger clears it when the specimen leaves HOLD (Schedule test), so C26's release
--   commands need no change. While set, the HOLD expiry is this date, not casting + the set's
--   HOLD days, and a casting correction leaves it alone.
-- * concrete_specimen_hold_assignment: append-only, one row per specimen per command: the age and
--   target date it had before, the hold-until date, reason, who and the command.
-- Reaching the date only flags the specimen for review (C22/C26): nothing runs on a date.

ALTER TABLE concrete_specimen
  ADD COLUMN hold_until date,
  ADD CONSTRAINT concrete_specimen_hold_until_kind CHECK (hold_until IS NULL OR assigned_age = 'HOLD');

ALTER TABLE concrete_hold_command DROP CONSTRAINT concrete_hold_command_kind_check;
ALTER TABLE concrete_hold_command
  ADD CONSTRAINT concrete_hold_command_kind_check
  CHECK (kind IN ('schedule_test', 'authorize_disposal', 'record_disposal', 'hold_until'));

CREATE TABLE concrete_specimen_hold_assignment (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL,
  specimen_id                   uuid NOT NULL,
  command_id                    uuid NOT NULL REFERENCES concrete_hold_command (id),
  previous_age                  text NOT NULL
                                  CONSTRAINT concrete_specimen_hold_assignment_previous_age_check
                                  CHECK (previous_age ~ '^[1-9][0-9]{0,2}$'),
  previous_target_date          date NOT NULL,
  hold_until                    date NOT NULL,
  reason                        text NOT NULL
                                  CONSTRAINT concrete_specimen_hold_assignment_reason_check
                                  CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  assigned_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  assigned_by_initials_snapshot text,
  assigned_by_name_snapshot     text NOT NULL,
  -- The transaction that made the change, so the specimen's guards can match it.
  transaction_id                bigint NOT NULL DEFAULT txid_current(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_specimen_hold_assignment_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE
);
CREATE INDEX concrete_specimen_hold_assignment_specimen_idx
  ON concrete_specimen_hold_assignment (specimen_id, created_at);
CREATE INDEX concrete_specimen_hold_assignment_command_idx
  ON concrete_specimen_hold_assignment (command_id);

CREATE TRIGGER concrete_specimen_hold_assignment_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_hold_assignment
  FOR EACH ROW EXECUTE FUNCTION concrete_hold_history_guard();
CREATE TRIGGER concrete_specimen_hold_assignment_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_hold_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_hold_history_guard();

-- C05's dates trigger, with the chosen hold-until date: a HOLD expires on it when set, else on
-- casting + the set's HOLD days; any age in days clears it.
CREATE OR REPLACE FUNCTION concrete_specimen_dates() RETURNS trigger
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
    NEW.hold_expires_on := coalesce(NEW.hold_until, casting + hold_days);
  ELSE
    NEW.hold_until := NULL;
    NEW.target_date := casting + NEW.assigned_age::integer;
    NEW.hold_expires_on := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- A hold-until date is written only with its history row (same transaction, same date). Named to
-- run after concrete_specimen_dates (BEFORE triggers fire in name order), so a date the dates
-- trigger cleared is not checked.
CREATE FUNCTION concrete_specimen_hold_until_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hold_until IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.hold_until IS DISTINCT FROM OLD.hold_until)
     AND NOT EXISTS (
       SELECT 1 FROM concrete_specimen_hold_assignment a
       WHERE a.specimen_id = NEW.id AND a.transaction_id = txid_current()
         AND a.hold_until = NEW.hold_until
     ) THEN
    RAISE EXCEPTION 'specimen % gets a hold-until date only through Hold until', NEW.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_hold_until_recorded';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_hold_until_guard
  BEFORE INSERT OR UPDATE ON concrete_specimen
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_hold_until_guard();

-- C26's age guard, widened by one path: a numbered set's scheduled specimen goes to HOLD with a
-- Hold until row recorded in the same transaction for exactly that change.
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
       )
       AND NOT (
         NEW.assigned_age = 'HOLD' AND EXISTS (
           SELECT 1 FROM concrete_specimen_hold_assignment a
           WHERE a.specimen_id = OLD.id AND a.transaction_id = txid_current()
             AND a.previous_age = OLD.assigned_age
         )
       ) THEN
      RAISE EXCEPTION 'specimen % keeps its assigned age in a numbered set', OLD.id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_age_fixed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
