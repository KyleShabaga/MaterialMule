-- MM-T65: a print job keeps the people on it as they were at the time, like audit events (0025)
-- and receipts: the receiver it credits (a print at a LAB station) and the requester as of the
-- request, and whoever confirmed the labels came out as of the confirmation (Kyle, 2026-10-27:
-- "Yes, all three"). Renaming, re-initialling or disabling someone later must not rewrite print
-- history.
--
-- Initials may be NULL: the shared LAB account and staff without confirmed initials are recorded
-- by name. The name is always there when the person is.

ALTER TABLE print_job
  ADD COLUMN requested_by_initials_snapshot text
    CONSTRAINT print_job_requested_by_initials_snapshot_check
    CHECK (requested_by_initials_snapshot ~ '^[A-Z]{1,5}$'),
  ADD COLUMN requested_by_name_snapshot text
    CONSTRAINT print_job_requested_by_name_snapshot_check
    CHECK (length(btrim(requested_by_name_snapshot)) BETWEEN 1 AND 200),
  ADD COLUMN receiver_initials_snapshot text
    CONSTRAINT print_job_receiver_initials_snapshot_check
    CHECK (receiver_initials_snapshot ~ '^[A-Z]{1,5}$'),
  ADD COLUMN receiver_name_snapshot text
    CONSTRAINT print_job_receiver_name_snapshot_check
    CHECK (length(btrim(receiver_name_snapshot)) BETWEEN 1 AND 200),
  ADD COLUMN confirmed_by_initials_snapshot text
    CONSTRAINT print_job_confirmed_by_initials_snapshot_check
    CHECK (confirmed_by_initials_snapshot ~ '^[A-Z]{1,5}$'),
  ADD COLUMN confirmed_by_name_snapshot text
    CONSTRAINT print_job_confirmed_by_name_snapshot_check
    CHECK (length(btrim(confirmed_by_name_snapshot)) BETWEEN 1 AND 200),
  -- Snapshots only with the person, and initials only with a name.
  ADD CONSTRAINT print_job_people_snapshot_pairing_check CHECK (
    (requested_by_name_snapshot IS NOT NULL OR requested_by_initials_snapshot IS NULL)
    AND (receiver_user_id IS NOT NULL OR receiver_name_snapshot IS NULL)
    AND (receiver_name_snapshot IS NOT NULL OR receiver_initials_snapshot IS NULL)
    AND (physically_confirmed_by_user_id IS NOT NULL OR confirmed_by_name_snapshot IS NULL)
    AND (confirmed_by_name_snapshot IS NOT NULL OR confirmed_by_initials_snapshot IS NULL)
  );

-- Older jobs: copy each person as history recorded them, where it did. Initials and name always
-- come from the same source; initials that don't fit today's rule are left out.

-- Requester and receiver: the job's print-requested event (receiver snapshots since MM-T56).
UPDATE print_job j
SET requested_by_initials_snapshot =
      CASE WHEN e.actor_initials_snapshot ~ '^[A-Z]{1,5}$' THEN e.actor_initials_snapshot END,
    requested_by_name_snapshot = e.actor_name_snapshot
FROM audit_event e
WHERE e.entity_type = 'print_job'
  AND e.entity_id = j.id
  AND e.action IN ('label.print_requested', 'label.reprint_requested')
  AND e.actor_user_id = j.requested_by_user_id
  AND length(btrim(e.actor_name_snapshot)) BETWEEN 1 AND 200;

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

-- Receiver, otherwise: the receipt of one of the job's units, when the job credits that receipt's
-- receiver.
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

-- Confirmer: the job's latest physically-confirmed event by that person.
UPDATE print_job j
SET confirmed_by_initials_snapshot =
      CASE WHEN e.actor_initials_snapshot ~ '^[A-Z]{1,5}$' THEN e.actor_initials_snapshot END,
    confirmed_by_name_snapshot = e.actor_name_snapshot
FROM (
  SELECT DISTINCT ON (entity_id) entity_id, actor_user_id, actor_initials_snapshot,
                                 actor_name_snapshot
  FROM audit_event
  WHERE entity_type = 'print_job' AND action = 'label.physically_confirmed'
    AND length(btrim(actor_name_snapshot)) BETWEEN 1 AND 200
  ORDER BY entity_id, occurred_at DESC, id DESC
) e
WHERE e.entity_id = j.id
  AND e.actor_user_id = j.physically_confirmed_by_user_id;

-- Jobs left without a snapshot predate the history above and show the person as they are now. A
-- CHECK can't tell those apart from new rows, so a trigger refuses a new job, a new or changed
-- receiver, or a new confirmation without the person's name snapshot, and refuses clearing one.
-- Older rows can still change status or be confirmed (with a snapshot).
CREATE FUNCTION print_job_people_snapshots_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requested_by_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR OLD.requested_by_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % has no requester name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.receiver_user_id IS NOT NULL AND NEW.receiver_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.receiver_user_id IS DISTINCT FROM OLD.receiver_user_id
    OR OLD.receiver_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % credits a receiver without a name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.physically_confirmed_by_user_id IS NOT NULL AND NEW.confirmed_by_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.physically_confirmed_by_user_id IS DISTINCT FROM OLD.physically_confirmed_by_user_id
    OR OLD.confirmed_by_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % is confirmed without the confirmer name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_people_snapshots_required
  BEFORE INSERT OR UPDATE ON print_job
  FOR EACH ROW EXECUTE FUNCTION print_job_people_snapshots_required();
