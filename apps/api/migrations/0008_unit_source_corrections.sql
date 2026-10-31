-- MM-T82 (owner decision, Kyle 2026-10-30): a Shelby tube's source and a bulk soil bucket's
-- group can be corrected, but not once the unit is disposed (either disposal route, which
-- covers a tested removal) or has any test-request link (exact-unit evidence of a completed
-- test, MM-T24). That evidence and the disposal record rest on the source the unit had. The
-- API refuses such a correction (422); this trigger is the backstop for any other writer.
--
-- No race with a new link: test_request_unit_link_guard (baseline) locks the unit FOR NO KEY
-- UPDATE before inserting, so a link and a source change of the same unit run one after the
-- other; a correction that waited on a link sees it here and is refused.
--
-- Group identity corrections (PATCH /api/bulk-groups/:id) change bulk_group, not the unit's
-- columns, so they are not covered here.
CREATE FUNCTION storage_unit_source_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_test_hole_id IS DISTINCT FROM OLD.source_test_hole_id
      OR NEW.source_location_reference IS DISTINCT FROM OLD.source_location_reference
      OR NEW.sample_reference IS DISTINCT FROM OLD.sample_reference
      OR NEW.sample_depth_from IS DISTINCT FROM OLD.sample_depth_from
      OR NEW.sample_depth_to IS DISTINCT FROM OLD.sample_depth_to
      OR NEW.sample_depth_unit IS DISTINCT FROM OLD.sample_depth_unit
      OR NEW.bulk_group_id IS DISTINCT FROM OLD.bulk_group_id)
     AND (OLD.status = 'disposed'
          OR EXISTS (SELECT 1 FROM test_request_unit_link WHERE storage_unit_id = OLD.id)) THEN
    RAISE EXCEPTION 'storage unit % is disposed or used in testing; its source and bulk sample can''t change',
      OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_source_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_source_final
  BEFORE UPDATE OF source_type, source_test_hole_id, source_location_reference, sample_reference,
    sample_depth_from, sample_depth_to, sample_depth_unit, bulk_group_id
  ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_source_final();
