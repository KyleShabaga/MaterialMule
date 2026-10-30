-- PR #104 review (BUG-014 backstop): storage_unit_hole_summary_disposed_final (0006) read the
-- parent unit without a lock, so a summary change could read "in stock" while a disposal of that
-- unit was committing, and both committed. It now share-locks every parent it checks, in id
-- order, before reading the status:
--   * a disposal holding the unit (either route locks it FOR UPDATE) makes the summary change
--     wait and then see "disposed", so it is refused;
--   * a summary change holding the unit makes a disposal wait until it has committed.
-- FOR SHARE, not FOR KEY SHARE: a status update takes FOR NO KEY UPDATE, which only FOR SHARE
-- blocks. Writers that rewrite summaries (corrections, receipts) already hold the unit FOR UPDATE
-- or created it in the same transaction, so this adds no wait or lock-order change for them.
-- 0006 stays as applied (the migrator checksums applied files); this replaces its function.
-- Errors and the fixture exception (a unit inserted already disposed, with no disposed_at, may
-- still be given summaries) are unchanged.
CREATE OR REPLACE FUNCTION storage_unit_hole_summary_disposed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
  parents uuid[];
BEGIN
  parents := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.storage_unit_id]
    WHEN 'DELETE' THEN ARRAY[OLD.storage_unit_id]
    ELSE ARRAY[OLD.storage_unit_id, NEW.storage_unit_id]
  END;
  -- Id order, so two moves between the same units can't lock them in opposite orders.
  PERFORM 1 FROM storage_unit WHERE id = ANY (parents) ORDER BY id FOR SHARE;

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
