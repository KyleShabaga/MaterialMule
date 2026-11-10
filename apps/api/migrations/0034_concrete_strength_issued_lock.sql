-- Review fix (PR #151 card "Keep previously issued results locked after recalling a later
-- submission"): 0032's lock looked only at the strength report's latest version, and only while
-- the report was submitted or reviewed. Recalling or returning a later-age submission (Rev n+1)
-- therefore reopened the results the issued Rev n reports, without C09's revise (review
-- authority, comment required).
--
-- A specimen is now locked (results of any attempt, and C24's exclusions) when either
--   - the latest version reports it and the report is submitted or reviewed (0032's rule), or
--   - the latest issued version reports it and no revise of that issued version has been
--     recorded (C09's revise transition names the version it revises).
-- After the revision is itself issued it is the latest issued version, so its results lock again.
-- Later ages (not on any issued version) stay open while the report is draft or returned.

CREATE FUNCTION concrete_strength_specimen_locked(p_specimen_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM concrete_specimen sp
    JOIN concrete_strength_report r ON r.specimen_set_id = sp.set_id
    WHERE sp.id = p_specimen_id
      AND (
        (r.workflow_state IN ('submitted', 'reviewed') AND EXISTS (
           SELECT 1 FROM (
             SELECT v.snapshot FROM concrete_report_version v
             WHERE v.strength_report_id = r.id ORDER BY v.version_no DESC LIMIT 1
           ) latest
           WHERE latest.snapshot->'results' @> jsonb_build_array(
                   jsonb_build_object('specimenId', sp.id::text, 'reported', true))))
        OR EXISTS (
           SELECT 1 FROM (
             SELECT v.id, v.snapshot FROM concrete_report_version v
             WHERE v.strength_report_id = r.id AND v.state = 'issued'
             ORDER BY v.version_no DESC LIMIT 1
           ) issued
           WHERE issued.snapshot->'results' @> jsonb_build_array(
                   jsonb_build_object('specimenId', sp.id::text, 'reported', true))
             AND NOT EXISTS (
               SELECT 1 FROM concrete_report_transition t
               WHERE t.strength_report_id = r.id AND t.version_id = issued.id
                 AND t.action = 'revise'))
      )
  );
$$;

CREATE OR REPLACE FUNCTION concrete_test_result_reported_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  IF concrete_strength_specimen_locked(NEW.specimen_id) THEN
    RAISE EXCEPTION 'this result is on a submitted or issued strength report'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_test_result_reported';
  END IF;
  RETURN NEW;
END;
$$;

-- As 0033, with the same lock rule.
CREATE OR REPLACE FUNCTION concrete_strength_exclusion_guard() RETURNS trigger
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
    IF concrete_strength_specimen_locked(NEW.specimen_id) THEN
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
