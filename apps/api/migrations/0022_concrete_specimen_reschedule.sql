-- MM-V2-C22: authorized specimen rescheduling with reason and history, and the indexes the daily
-- lab worklist reads (Today / Overdue / Upcoming / HOLD). Adds one table and replaces C05's age
-- guard; changes no existing row.
--
-- The worklist itself stores nothing: Today, Overdue and Upcoming are derived from C05's stored
-- target dates (casting date in America/Edmonton + assigned age), HOLD from the stored HOLD
-- expiry. Listing a specimen as overdue never moves its target (card AC2). Reaching a HOLD expiry
-- only flags it for review: nothing here tests, releases or disposes of anything (AC3; HOLD
-- actions are C26).
--
-- A reschedule changes a specimen's assigned age in days; the database recomputes its target from
-- the casting date (C05 trigger), so the target always equals casting + age and the history row
-- keeps the age and target before and after. HOLD specimens are not rescheduled here (C26).

CREATE TABLE concrete_specimen_reschedule (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                       uuid NOT NULL,
  specimen_id                      uuid NOT NULL,
  previous_age                     text NOT NULL
                                     CONSTRAINT concrete_specimen_reschedule_previous_age_check
                                     CHECK (previous_age ~ '^[1-9][0-9]{0,2}$'),
  new_age                          text NOT NULL
                                     CONSTRAINT concrete_specimen_reschedule_new_age_check
                                     CHECK (new_age ~ '^[1-9][0-9]{0,2}$'),
  previous_target_date             date NOT NULL,
  new_target_date                  date NOT NULL,
  reason                           text NOT NULL
                                     CONSTRAINT concrete_specimen_reschedule_reason_check
                                     CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  rescheduled_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  rescheduled_by_initials_snapshot text,
  rescheduled_by_name_snapshot     text NOT NULL,
  idempotency_key                  uuid NOT NULL UNIQUE,
  request_hash                     text NOT NULL,
  -- The transaction that made the change, so the specimen's age guard can match it.
  transaction_id                   bigint NOT NULL DEFAULT txid_current(),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_specimen_reschedule_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_specimen_reschedule_changes CHECK (previous_age <> new_age)
);
CREATE INDEX concrete_specimen_reschedule_specimen_idx
  ON concrete_specimen_reschedule (specimen_id, created_at);
CREATE INDEX concrete_specimen_reschedule_user_idx
  ON concrete_specimen_reschedule (rescheduled_by_user_id);

-- History is append-only; only a project correction cascading from the specimen changes a row.
CREATE FUNCTION concrete_specimen_reschedule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'concrete specimen reschedules are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_reschedule_append_only';
END;
$$;
CREATE TRIGGER concrete_specimen_reschedule_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_reschedule
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_reschedule_guard();
CREATE TRIGGER concrete_specimen_reschedule_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_reschedule
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_reschedule_guard();

-- C05's guard, widened by exactly one path: a specimen of a numbered set changes its assigned age
-- only together with a reschedule recorded in the same transaction for exactly that change
-- (who, why, before and after). Every other age change on a numbered set is still refused.
CREATE OR REPLACE FUNCTION concrete_specimen_age_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_age IS DISTINCT FROM OLD.assigned_age
     AND EXISTS (SELECT 1 FROM concrete_specimen_set s
                 WHERE s.id = OLD.set_id AND s.permanent_number IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM concrete_specimen_reschedule r
       WHERE r.specimen_id = OLD.id AND r.transaction_id = txid_current()
         AND r.previous_age = OLD.assigned_age AND r.new_age = NEW.assigned_age
     ) THEN
    RAISE EXCEPTION 'specimen % keeps its assigned age in a numbered set', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_age_fixed';
  END IF;
  RETURN NEW;
END;
$$;

-- The worklist reads lab-wide by date (C05's indexes lead with project_id, for one project).
CREATE INDEX concrete_specimen_worklist_target_idx
  ON concrete_specimen (target_date) WHERE target_date IS NOT NULL;
CREATE INDEX concrete_specimen_worklist_hold_idx
  ON concrete_specimen (hold_expires_on) WHERE assigned_age = 'HOLD';
