-- Core boxes (CRE-) as a storage unit type you can receive (Kyle, 2026-11-10; D11 approved).
--
-- A core box belongs to one test hole and holds 1 to 3 core runs of 1.52 m each (1.52, 3.04 or
-- 4.56 m). Most boxes are full (3 runs, 4.56 m); usually only the last box of a hole holds fewer.
-- The run count is a current value like the unit type: a correction may change it, and the
-- issued CRE- ID never changes. The box's contents summary is its one test hole's ordinary
-- SAMPLE#/DEPTH hole summary (All samples, a depth range, ...), so receiving, inventory, lab
-- coverage and labels treat it like a bucket's.
--
-- No existing row changes: no storage unit has unit_type core_box yet, and every other unit
-- keeps core_run_count NULL.

ALTER TABLE storage_unit
  DROP CONSTRAINT storage_unit_unit_type_check,
  ADD CONSTRAINT storage_unit_unit_type_check
    CHECK (unit_type IN ('bucket', 'shelby_tube', 'bulk_container', 'core_box'));

ALTER TABLE storage_unit
  DROP CONSTRAINT storage_unit_type_matches_holder_check,
  ADD CONSTRAINT storage_unit_type_matches_holder_check CHECK (
    (unit_type = 'bucket' AND holder_kind = 'bucket')
    OR (unit_type = 'shelby_tube' AND holder_kind = 'shelby_tube')
    OR (unit_type = 'bulk_container' AND holder_kind IN ('bucket', 'generic'))
    OR (unit_type = 'core_box' AND holder_kind = 'core_box')
  );

-- A core box is summarised per test hole, like an ordinary bucket: no own source, no group.
ALTER TABLE storage_unit
  DROP CONSTRAINT storage_unit_contents_by_type_check,
  ADD CONSTRAINT storage_unit_contents_by_type_check CHECK (
    (unit_type = 'bucket' AND source_type IS NULL AND bulk_group_id IS NULL)
    OR (unit_type = 'shelby_tube' AND bulk_group_id IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'bucket'
        AND bulk_group_id IS NOT NULL AND source_type IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'generic'
        AND bulk_group_id IS NULL AND source_type IS NULL)
    OR (unit_type = 'core_box' AND source_type IS NULL AND bulk_group_id IS NULL)
  );

-- Runs of 1.52 m: 1, 2 or 3. Every core box has a count; no other unit has one.
ALTER TABLE storage_unit
  ADD COLUMN core_run_count smallint
    CONSTRAINT storage_unit_core_run_count_check CHECK (core_run_count BETWEEN 1 AND 3),
  ADD CONSTRAINT storage_unit_core_runs_by_type_check
    CHECK ((unit_type = 'core_box') = (core_run_count IS NOT NULL));

-- A core box belongs to exactly one test hole. Checked at commit, so receiving (unit, then its
-- summary) and a correction (summaries replaced as a set) can pass through zero inside the
-- transaction; only core boxes queue a check on the unit side. The unit row is locked first, so two transactions adding a summary to the same
-- box run one after the other and the second sees the first's row.
CREATE FUNCTION storage_unit_core_box_one_test_hole() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_ids uuid[];
  unit_id uuid;
  unit record;
  holes integer;
BEGIN
  IF TG_TABLE_NAME = 'storage_unit' THEN
    unit_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    unit_ids := ARRAY[NEW.storage_unit_id];
  ELSIF TG_OP = 'DELETE' THEN
    unit_ids := ARRAY[OLD.storage_unit_id];
  ELSE
    unit_ids := ARRAY[OLD.storage_unit_id, NEW.storage_unit_id];
  END IF;
  FOREACH unit_id IN ARRAY unit_ids LOOP
    SELECT su.readable_id, su.unit_type INTO unit
    FROM storage_unit su WHERE su.id = unit_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR unit.unit_type <> 'core_box';
    SELECT count(*) INTO holes FROM storage_unit_hole_summary WHERE storage_unit_id = unit_id;
    IF holes <> 1 THEN
      RAISE EXCEPTION 'core box % must belong to exactly one test hole (has %)',
        unit.readable_id, holes
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_core_box_one_test_hole';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER storage_unit_core_box_one_test_hole
  AFTER INSERT OR UPDATE OF unit_type ON storage_unit
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.unit_type = 'core_box')
  EXECUTE FUNCTION storage_unit_core_box_one_test_hole();

CREATE CONSTRAINT TRIGGER storage_unit_core_box_summary_one_test_hole
  AFTER INSERT OR UPDATE OR DELETE ON storage_unit_hole_summary
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION storage_unit_core_box_one_test_hole();

-- A disposed core box's runs are final, like its type and test hole (BUG-014). The API refuses it
-- too (422 storage_unit_disposed); this is the backstop for any other writer.
CREATE FUNCTION storage_unit_disposed_core_runs_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disposed' AND NEW.core_run_count IS DISTINCT FROM OLD.core_run_count THEN
    RAISE EXCEPTION 'storage unit % is disposed; its core runs can''t change', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_core_runs_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_core_runs_final
  BEFORE UPDATE OF core_run_count ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_core_runs_final();
