-- BUG-014 (owner decision, Kyle 2026-10-30): a disposed storage unit's project, unit type and
-- test-hole summaries are final. Its disposal approval and removal record rest on them, and both
-- are append-only. The API refuses such a correction (422 storage_unit_disposed); these triggers
-- are the backstop for any other writer. Received date and note stay correctable until the owner
-- decides otherwise.

-- A unit removed after testing is already guarded by storage_unit_tested_removal_final (MM-T36),
-- which also covers status; this covers every other disposed unit, so neither rule weakens the
-- other and a tested removal keeps reporting its own constraint.
CREATE FUNCTION storage_unit_disposed_contents_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disposed'
     AND (NEW.unit_type IS DISTINCT FROM OLD.unit_type
          OR NEW.holder_kind IS DISTINCT FROM OLD.holder_kind
          OR NEW.project_id IS DISTINCT FROM OLD.project_id)
     AND NOT EXISTS (SELECT 1 FROM tested_unit_removal WHERE storage_unit_id = OLD.id) THEN
    RAISE EXCEPTION 'storage unit % is disposed; its project and type can''t change', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_contents_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_contents_final
  BEFORE UPDATE OF unit_type, holder_kind, project_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_contents_final();

-- Hole summaries live in their own table, so the unit trigger alone doesn't cover them. A
-- disposed unit's summaries can't be edited or removed, and none can be added once a disposal
-- has been recorded (both disposal routes set disposed_at). Fixtures that insert a unit already
-- marked disposed, with no recorded disposal, can still add its summaries after it.
CREATE FUNCTION storage_unit_hole_summary_disposed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO unit FROM storage_unit WHERE id = OLD.storage_unit_id;
    IF unit.status = 'disposed' THEN
      RAISE EXCEPTION 'storage unit % is disposed; its test-hole summaries can''t change',
        unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_contents_final';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
    IF unit.status = 'disposed' AND (TG_OP = 'UPDATE' OR unit.disposed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'storage unit % is disposed; its test-hole summaries can''t change',
        unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_contents_final';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER storage_unit_hole_summary_disposed_final
  BEFORE INSERT OR UPDATE OR DELETE ON storage_unit_hole_summary
  FOR EACH ROW EXECUTE FUNCTION storage_unit_hole_summary_disposed_final();
