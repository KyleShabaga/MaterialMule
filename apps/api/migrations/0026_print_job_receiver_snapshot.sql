-- MM-T65: a print job that credits a receiver (a print at a LAB station) keeps the receiver's
-- initials and name as they were when the job was requested, like audit events (0025) and
-- receipts. Renaming, re-initialling or disabling the person later must not rewrite print history.
--
-- Initials may be NULL: staff without confirmed initials are recorded by name.

ALTER TABLE print_job
  ADD COLUMN receiver_initials_snapshot text
    CONSTRAINT print_job_receiver_initials_snapshot_check
    CHECK (receiver_initials_snapshot ~ '^[A-Z]{1,5}$'),
  ADD COLUMN receiver_name_snapshot text
    CONSTRAINT print_job_receiver_name_snapshot_check
    CHECK (length(btrim(receiver_name_snapshot)) BETWEEN 1 AND 200),
  -- Snapshots only with a receiver, and initials only with a name.
  ADD CONSTRAINT print_job_receiver_snapshot_pairing_check CHECK (
    (receiver_user_id IS NOT NULL OR receiver_name_snapshot IS NULL)
    AND (receiver_name_snapshot IS NOT NULL OR receiver_initials_snapshot IS NULL)
  );

-- Older jobs: copy the time-of-print receiver where history has one. First the job's
-- print-requested event (written with snapshots since MM-T56), then the receipt of one of the
-- job's units when the job credits that receipt's receiver. Initials and name always come from
-- the same source.
UPDATE print_job j
SET receiver_initials_snapshot = e.receiver_initials_snapshot,
    receiver_name_snapshot = e.receiver_name_snapshot
FROM audit_event e
WHERE j.receiver_user_id IS NOT NULL
  AND e.entity_type = 'print_job'
  AND e.entity_id = j.id
  AND e.action IN ('label.print_requested', 'label.reprint_requested')
  AND e.receiver_user_id = j.receiver_user_id
  AND e.receiver_name_snapshot IS NOT NULL;

UPDATE print_job j
SET receiver_initials_snapshot = r.receiver_initials_snapshot,
    receiver_name_snapshot = r.receiver_name_snapshot
FROM (
  SELECT DISTINCT ON (i.print_job_id)
         i.print_job_id, r.receiver_initials_snapshot, r.receiver_name_snapshot
  FROM print_job_item i
  JOIN print_job pj ON pj.id = i.print_job_id
  JOIN storage_unit su ON su.id = i.storage_unit_id
  JOIN receipt r ON r.id = su.receipt_id AND r.receiver_user_id = pj.receiver_user_id
  WHERE pj.receiver_user_id IS NOT NULL AND pj.receiver_name_snapshot IS NULL
    AND r.receiver_initials_snapshot ~ '^[A-Z]{1,5}$'
  ORDER BY i.print_job_id, i.position
) r
WHERE r.print_job_id = j.id;

-- Jobs left without a snapshot predate both and show the person as they are now. A CHECK can't
-- tell those apart from new rows, so a trigger refuses a new or re-credited receiver job without
-- a name snapshot, and refuses clearing one. Older rows can still change status or be confirmed.
CREATE FUNCTION print_job_receiver_snapshot_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receiver_user_id IS NOT NULL AND NEW.receiver_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.receiver_user_id IS DISTINCT FROM OLD.receiver_user_id
    OR OLD.receiver_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % credits a receiver without a name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_receiver_snapshot_required
  BEFORE INSERT OR UPDATE OF receiver_user_id, receiver_name_snapshot ON print_job
  FOR EACH ROW EXECUTE FUNCTION print_job_receiver_snapshot_required();
