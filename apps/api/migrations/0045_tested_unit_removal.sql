-- MM-T36 (Stage 4 Lane B): removal of tested Shelby tubes and tested bulk soil buckets.
--
-- Two separate facts, never inferred from each other:
--   1. Testing (MM-T24): a completion linked the exact physical unit (test_request_unit_link).
--      For a Shelby tube that alone means its contents were destroyed during testing and are
--      unusable: the tube can't be covered by a new program or linked as tested by another
--      program. The tube itself stays in stock at its saved location.
--   2. Physical removal (this migration): a personal account confirms that the whole unit has
--      actually left the lab, naming the completed test that used it. The unit becomes
--      `disposed` (shown "Disposed after testing"), keeps its last saved location as history and
--      no longer occupies that location or counts as Current stock.
--
-- The post-testing route is the T36 exception: no retention wait, extension or hold, disposal
-- approval, standard disposal scan or covering-program closure applies. It never changes test
-- requests, review, acceptance or program status, and never touches sibling tubes or buckets.
--
-- Eligible units: a Shelby tube (reason tested_shelby) or a bucket holding a bulk soil sample,
-- i.e. unit_type bulk_container in a bulk group (reason tested_bulk), with a completion link of
-- a request that is not cancelled. Ordinary buckets never qualify.

-- ---------------------------------------------------------------------------------------------
-- Contents destroyed during testing (Shelby tubes)
-- ---------------------------------------------------------------------------------------------

-- The program whose completion first used this Shelby tube, or null when its contents are
-- still available (not a tube, or no completed test linked to it). A cancelled request's link
-- doesn't count.
CREATE FUNCTION shelby_contents_destroyed_by_program(unit_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.program_id
  FROM storage_unit su
  JOIN test_request_unit_link l ON l.storage_unit_id = su.id
  JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
  JOIN test_request r ON r.id = l.test_request_id
  WHERE su.id = unit_id AND su.unit_type = 'shelby_tube' AND r.status <> 'cancelled'
  ORDER BY h.changed_at, h.id
  LIMIT 1
$$;

-- Backstop for the lab service: tested-unit evidence never names a disposed unit, and a Shelby
-- tube whose contents another program already destroyed can't be tested again. Tests of the
-- same program (frozen together at submission) may still record the tube.
CREATE FUNCTION test_request_unit_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_status text;
  destroyed_by uuid;
  link_program uuid;
BEGIN
  SELECT status INTO unit_status FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit_status = 'disposed' THEN
    RAISE EXCEPTION 'storage unit % is disposed and can''t be linked as tested', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_not_disposed';
  END IF;
  destroyed_by := shelby_contents_destroyed_by_program(NEW.storage_unit_id);
  SELECT program_id INTO link_program FROM test_request WHERE id = NEW.test_request_id;
  IF destroyed_by IS NOT NULL AND destroyed_by <> link_program THEN
    RAISE EXCEPTION 'Shelby tube % contents were destroyed during testing', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_contents_available';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_unit_link_guard
  BEFORE INSERT ON test_request_unit_link
  FOR EACH ROW EXECUTE FUNCTION test_request_unit_link_guard();

-- ---------------------------------------------------------------------------------------------
-- Tested-unit removal
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tested_unit_removal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One removal per physical unit, ever: retries and concurrent requests can't add a second.
  storage_unit_id             uuid NOT NULL UNIQUE REFERENCES storage_unit (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot   text NOT NULL,
  unit_type_snapshot          text NOT NULL CHECK (unit_type_snapshot IN ('shelby_tube', 'bulk_container')),
  bulk_group_id_snapshot      uuid REFERENCES bulk_group (id),
  reason                      text NOT NULL CHECK (reason IN ('tested_shelby', 'tested_bulk')),
  -- The completed test the person named as the basis, and its completion event.
  test_request_id             uuid NOT NULL REFERENCES test_request (id),
  unit_link_id                uuid NOT NULL REFERENCES test_request_unit_link (id),
  completion_event_id         uuid NOT NULL REFERENCES test_request_status_history (id),
  program_number_snapshot     text NOT NULL,
  test_code_snapshot          text NOT NULL,
  -- The unit as it was just before removal. The location stays on storage_unit as history.
  previous_status             text NOT NULL CHECK (previous_status IN ('in_stock', 'approved_for_disposal')),
  location_id                 uuid NOT NULL REFERENCES location (id),
  location_code_snapshot      text NOT NULL,
  location_name_snapshot      text NOT NULL,
  -- The personal account that confirmed the physical removal (never LAB).
  removed_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  removed_by_account_type     text NOT NULL CHECK (removed_by_account_type IN ('personal', 'test')),
  removed_by_initials_snapshot text,
  removed_by_name_snapshot    text NOT NULL,
  physical_removal_confirmed  boolean NOT NULL CHECK (physical_removal_confirmed),
  removed_at                  timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  CONSTRAINT tested_unit_removal_reason_matches_type CHECK (
    (reason = 'tested_shelby' AND unit_type_snapshot = 'shelby_tube' AND bulk_group_id_snapshot IS NULL)
    OR (reason = 'tested_bulk' AND unit_type_snapshot = 'bulk_container'
        AND bulk_group_id_snapshot IS NOT NULL)
  )
);
CREATE INDEX tested_unit_removal_project_idx ON tested_unit_removal (project_id, removed_at);
CREATE INDEX tested_unit_removal_request_idx ON tested_unit_removal (test_request_id);

CREATE TRIGGER tested_unit_removal_append_only
  BEFORE UPDATE OR DELETE ON tested_unit_removal
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- A removal row is written in the transaction that disposes the unit, after the unit update,
-- and must rest on real exact-unit evidence of a request that isn't cancelled.
CREATE FUNCTION tested_unit_removal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit.status <> 'disposed' OR unit.project_id <> NEW.project_id
     OR unit.unit_type <> NEW.unit_type_snapshot
     OR unit.bulk_group_id IS DISTINCT FROM NEW.bulk_group_id_snapshot
     OR unit.current_location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'tested removal of % doesn''t match the unit', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tested_unit_removal_matches_unit';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM test_request_unit_link l
    JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
    JOIN test_request r ON r.id = l.test_request_id
    JOIN lab_program lp ON lp.id = r.program_id
    WHERE l.id = NEW.unit_link_id AND l.storage_unit_id = NEW.storage_unit_id
      AND l.test_request_id = NEW.test_request_id AND h.id = NEW.completion_event_id
      AND l.project_id = NEW.project_id AND lp.project_id = NEW.project_id
      AND r.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'tested removal of % needs completed-test evidence for that exact unit',
      unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tested_unit_removal_evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tested_unit_removal_guard
  BEFORE INSERT ON tested_unit_removal
  FOR EACH ROW EXECUTE FUNCTION tested_unit_removal_guard();

-- A unit removed after testing stays removed: no edit returns it to stock, and the facts the
-- removal rested on (project, unit type) can't change under it. Other corrections still work.
CREATE FUNCTION storage_unit_tested_removal_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.unit_type IS DISTINCT FROM OLD.unit_type
      OR NEW.project_id IS DISTINCT FROM OLD.project_id)
     AND EXISTS (SELECT 1 FROM tested_unit_removal WHERE storage_unit_id = OLD.id) THEN
    RAISE EXCEPTION 'storage unit % was removed after testing', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_tested_removal_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_tested_removal_final
  BEFORE UPDATE OF status, unit_type, project_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_tested_removal_is_final();
