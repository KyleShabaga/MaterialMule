-- MM-T73 (owner decision 2026-10-28, option B): tested-unit evidence outside a line's coverage.
--
-- A Specific line covers only the units chosen on it, and a Grabs/SPT line only the units
-- reviewed and included, so a Shelby tube or bulk-sample bucket that the lab actually tested
-- could be outside the frozen coverage and never get completion evidence (and so never be
-- removed after testing). A completion may now also link such a unit when it comes from the
-- line's own sampling source in the program's project, with an explicit confirmation by the
-- person completing the test. The confirmed link is ordinary exact-unit evidence: it destroys a
-- tube's contents for other programs (shelby_contents_destroyed_by_program) and is the basis for
-- MM-T36 removal after testing, exactly like a covered unit's link. Coverage itself is never
-- changed (it stays frozen).
--
-- Each link now says why it is allowed:
--   frozen_coverage        the unit is included in the line's frozen coverage (as before; no
--                          confirmation);
--   same_source_confirmed  the unit is outside that coverage, but is a Shelby tube or bulk-sample
--                          bucket of the line's source in the program's project, and the account
--                          and person of the completion confirmed it (who and when are kept).
-- The database refuses any other link: a unit of another source or project, an ordinary bucket
-- outside coverage, a confirmation for a covered unit, or a confirmation by someone other than
-- the completion's own account and person.

ALTER TABLE test_request_unit_link
  ADD COLUMN coverage_basis text NOT NULL DEFAULT 'frozen_coverage'
    CHECK (coverage_basis IN ('frozen_coverage', 'same_source_confirmed')),
  ADD COLUMN confirmed_by_account_user_id uuid REFERENCES app_user (id),
  ADD COLUMN confirmed_by_person_user_id uuid REFERENCES app_user (id),
  ADD COLUMN confirmed_by_person_initials_snapshot text,
  ADD COLUMN confirmed_by_person_name_snapshot text,
  ADD COLUMN confirmed_at timestamptz,
  ADD CONSTRAINT test_request_unit_link_confirmation_shape CHECK (
    (coverage_basis = 'frozen_coverage' AND confirmed_by_account_user_id IS NULL
     AND confirmed_by_person_user_id IS NULL AND confirmed_by_person_initials_snapshot IS NULL
     AND confirmed_by_person_name_snapshot IS NULL AND confirmed_at IS NULL)
    OR (coverage_basis = 'same_source_confirmed' AND confirmed_by_account_user_id IS NOT NULL
        AND confirmed_by_person_user_id IS NOT NULL
        AND length(btrim(confirmed_by_person_name_snapshot)) > 0 AND confirmed_at IS NOT NULL)
  );

-- True when `unit_id` is a unit of `line_id`'s sampling source in the line's project, by the
-- same rules as coverage candidates (apps/api/src/lab/coverage.ts), ignoring availability:
--   test hole             → a hole summary for the hole, a tube sourced from it, or a bucket of
--                           a bulk group sourced from it;
--   standalone tube       → that tube;
--   standalone bulk group → its member buckets.
CREATE FUNCTION storage_unit_of_line_source(line_id uuid, unit_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM test_line tl JOIN storage_unit su ON su.id = unit_id AND su.project_id = tl.project_id
    WHERE tl.id = line_id AND CASE tl.source_kind
      WHEN 'test_hole' THEN
        su.source_test_hole_id = tl.test_hole_id
        OR EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                   WHERE h.storage_unit_id = su.id AND h.test_hole_id = tl.test_hole_id)
        OR EXISTS (SELECT 1 FROM bulk_group g
                   WHERE g.id = su.bulk_group_id AND g.test_hole_id = tl.test_hole_id)
      WHEN 'standalone_unit' THEN su.id = tl.source_storage_unit_id
      WHEN 'standalone_bulk_group' THEN su.bulk_group_id = tl.source_bulk_group_id
      ELSE false
    END
  )
$$;

-- The 0076 guard (row lock, disposed, destroyed contents) plus the coverage basis.
CREATE OR REPLACE FUNCTION test_request_unit_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
  destroyed_by uuid;
  req record;
  event record;
  covered boolean;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id FOR NO KEY UPDATE;
  IF unit.status = 'disposed' THEN
    RAISE EXCEPTION 'storage unit % is disposed and can''t be linked as tested', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_not_disposed';
  END IF;
  destroyed_by := shelby_contents_destroyed_by_program(NEW.storage_unit_id);
  SELECT r.program_id, r.line_id, lp.project_id INTO req
  FROM test_request r JOIN lab_program lp ON lp.id = r.program_id
  WHERE r.id = NEW.test_request_id;
  IF destroyed_by IS NOT NULL AND destroyed_by <> req.program_id THEN
    RAISE EXCEPTION 'Shelby tube % contents were destroyed during testing', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_contents_available';
  END IF;
  -- Evidence stays inside the program's project.
  IF NEW.project_id <> req.project_id OR unit.project_id <> req.project_id THEN
    RAISE EXCEPTION 'storage unit % is not in this program''s project', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_same_project';
  END IF;
  covered := EXISTS (SELECT 1 FROM program_scope_snapshot s
                     WHERE s.line_id = req.line_id AND s.storage_unit_id = NEW.storage_unit_id
                       AND s.included);
  IF NEW.coverage_basis = 'frozen_coverage' THEN
    IF NOT covered THEN
      RAISE EXCEPTION 'storage unit % is not part of this line''s coverage', unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_covered';
    END IF;
  ELSE
    IF covered
       OR NOT (unit.unit_type = 'shelby_tube' OR unit.bulk_group_id IS NOT NULL)
       OR NOT storage_unit_of_line_source(req.line_id, NEW.storage_unit_id) THEN
      RAISE EXCEPTION 'storage unit % can''t be confirmed as same-source tested material',
        unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_same_source';
    END IF;
    -- The confirmation is the completion's own: same account and person as its event.
    SELECT h.account_user_id, h.person_user_id, h.test_request_id, h.to_status INTO event
    FROM test_request_status_history h WHERE h.id = NEW.status_history_id;
    IF event.test_request_id IS DISTINCT FROM NEW.test_request_id
       OR event.to_status IS DISTINCT FROM 'completed'
       OR event.account_user_id IS DISTINCT FROM NEW.confirmed_by_account_user_id
       OR event.person_user_id IS DISTINCT FROM NEW.confirmed_by_person_user_id THEN
      RAISE EXCEPTION 'a same-source confirmation must be made by the completion''s own account and person'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_confirmed_by_completer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
