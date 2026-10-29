-- MM-T70: a disposal approval is only valid for the project it was granted under (D19).
--
-- An approval is recorded under the unit's project at that moment. If the unit's project is
-- corrected afterwards, the approval no longer authorises the standard removal: the new
-- project's Lead Project Engineer or a Lab Manager has to approve again. The API refuses that scan as Not
-- approved; these rules make the database refuse it too.
--
-- 1. A new approval must name the unit's current project.
-- 2. A standard removal must rest on an approval granted under the unit's current project
--    (disposal_removal_guard from 0065, now also comparing the approval's project).
--
-- MM-T36's post-testing route (tested_unit_removal) is unchanged: it never needed an approval.

CREATE FUNCTION disposal_approval_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage_unit su
                 WHERE su.id = NEW.storage_unit_id AND su.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a disposal approval must be under the unit''s current project'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_approval_matches_unit_project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_approval_project_guard
  BEFORE INSERT ON disposal_approval
  FOR EACH ROW EXECUTE FUNCTION disposal_approval_project_guard();

CREATE OR REPLACE FUNCTION disposal_removal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit.status <> 'disposed' OR unit.project_id <> NEW.project_id
     OR unit.current_location_id <> NEW.location_id
     OR NOT EXISTS (SELECT 1 FROM disposal_approval a
                    WHERE a.id = NEW.approval_id AND a.storage_unit_id = NEW.storage_unit_id
                      AND a.project_id = unit.project_id
                      AND a.revoked_at IS NULL AND a.used_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = NEW.storage_unit_id) THEN
    RAISE EXCEPTION 'disposal of % doesn''t match the unit and its approval', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_removal_matches_unit';
  END IF;
  RETURN NEW;
END;
$$;
