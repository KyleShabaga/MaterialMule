-- MM-T47: an issued storage unit ID can never be reused (CLAUDE.md "Never" rule).
-- Enforced by triggers (not only grants) because the table owner bypasses grants.
-- * storage_unit rows can't be deleted or truncated: the row is the record that its readable_id was
--   issued, and the UNIQUE constraint on readable_id only blocks a reissue while the row exists.
--   Units leave the lab through status (approved_for_disposal / disposed), never by deletion.
-- * storage_unit_annual_counter rows can't be deleted or truncated, and last_value can never go
--   down: either would let the allocator hand out a number that was already issued. Raising a
--   counter stays allowed (needed after a restore).
-- Receipts need no trigger: storage_unit.receipt_id (no ON DELETE action) already refuses
-- deleting a receipt that issued units. Hole summaries carry no ID and are replaced by corrections.
-- Test and dev resets drop and recreate the schema, so they are unaffected.

CREATE FUNCTION storage_unit_id_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    RAISE EXCEPTION 'storage unit % can''t be deleted: issued storage unit IDs are permanent',
      OLD.readable_id
      USING ERRCODE = 'restrict_violation',
            HINT = 'Record disposal through the unit status instead.';
  END IF;
  RAISE EXCEPTION '% on storage_unit is not allowed: issued storage unit IDs are permanent', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER storage_unit_no_delete
  BEFORE DELETE ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_id_is_permanent();

CREATE TRIGGER storage_unit_no_truncate
  BEFORE TRUNCATE ON storage_unit
  FOR EACH STATEMENT EXECUTE FUNCTION storage_unit_id_is_permanent();

CREATE FUNCTION storage_unit_counter_never_goes_back() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prefix IS DISTINCT FROM OLD.prefix OR NEW.year IS DISTINCT FROM OLD.year THEN
      RAISE EXCEPTION 'storage unit counter %-% can''t be moved to another prefix or year',
        OLD.prefix, OLD.year
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.last_value < OLD.last_value THEN
      RAISE EXCEPTION 'storage unit counter %-% can''t go down from % to %: issued IDs are never reused',
        OLD.prefix, OLD.year, OLD.last_value, NEW.last_value
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_LEVEL = 'ROW' THEN
    RAISE EXCEPTION 'storage unit counter %-% can''t be deleted: issued IDs are never reused',
      OLD.prefix, OLD.year
      USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION '% on storage_unit_annual_counter is not allowed: issued IDs are never reused',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER storage_unit_annual_counter_no_decrease
  BEFORE UPDATE OR DELETE ON storage_unit_annual_counter
  FOR EACH ROW EXECUTE FUNCTION storage_unit_counter_never_goes_back();

CREATE TRIGGER storage_unit_annual_counter_no_truncate
  BEFORE TRUNCATE ON storage_unit_annual_counter
  FOR EACH STATEMENT EXECUTE FUNCTION storage_unit_counter_never_goes_back();
