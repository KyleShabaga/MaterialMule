-- MM-T77: a disposed storage unit's ID never gets a fresh sticker.
--
-- Disposal (MM-T36 tested removal or MM-T30 disposal) is final, and an issued ID is never reused,
-- so no new print job may name a disposed unit. The API refuses such a request (422
-- storage_unit_disposed, nothing queued); this is the backstop for any other writer. The unit's
-- row is share-locked so a concurrent disposal (which locks the unit FOR UPDATE) either waits
-- for the job or is seen by it. Existing print history for a unit disposed later is untouched and
-- stays readable: only new items are checked, and only for a job requested at or after the
-- disposal (both disposal routes record disposed_at), so history from before a disposal can
-- still be loaded, e.g. by imports and the benchmark generator.

CREATE FUNCTION print_job_item_not_disposed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_status text;
  unit_disposed_at timestamptz;
  job_created_at timestamptz;
BEGIN
  SELECT status, disposed_at INTO unit_status, unit_disposed_at
  FROM storage_unit WHERE id = NEW.storage_unit_id FOR SHARE;
  SELECT created_at INTO job_created_at FROM print_job WHERE id = NEW.print_job_id;
  IF unit_status = 'disposed' AND unit_disposed_at IS NOT NULL
     AND job_created_at >= unit_disposed_at THEN
    RAISE EXCEPTION 'storage unit % is disposed; no label is printed for it', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'print_job_item_not_disposed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_item_not_disposed
  BEFORE INSERT ON print_job_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_not_disposed();
