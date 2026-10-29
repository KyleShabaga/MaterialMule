-- MM-T76: two programs can't both record the same Shelby tube as tested.
--
-- The 0045 backstop read shelby_contents_destroyed_by_program() without serialising, so two
-- completions in different programs could both see the tube as untested and both commit. The
-- guard now takes the unit's row lock (NO KEY UPDATE: it serialises with other completions,
-- moves, corrections, removal and disposal, which all lock the unit, but not with foreign-key
-- checks) before reading, so a second completion waits for the first and then sees its evidence.
-- The lab service takes the same lock first (units before the request), so in the service path
-- this re-lock never waits. Otherwise unchanged from 0045.

CREATE OR REPLACE FUNCTION test_request_unit_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_status text;
  destroyed_by uuid;
  link_program uuid;
BEGIN
  SELECT status INTO unit_status FROM storage_unit WHERE id = NEW.storage_unit_id
    FOR NO KEY UPDATE;
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
