-- MM-T37: storage locations administration and location labels.
--
-- Location record: optional area/group, retirement (when, why), optimistic version, and the two
-- label facts kept apart on purpose:
-- * code_locked_at: set in the same transaction as the location's FIRST label print request.
--   From then on the code (and so the LOC-<CODE> payload) can never change, whatever happens to
--   the job: a queued, sending or uncertain job may already be on a shelf edge.
-- * label_printed_at: set only when a person confirms a location label physically came out
--   (print_job.physically_confirmed_at). Queuing or sending a job never sets it.
--
-- Retirement hides a location from new moves but keeps every reference to it (history, audit,
-- print jobs) readable. Units can't be placed in a retired location: storage_unit inserts and
-- location changes lock the destination row (FOR KEY SHARE) and re-read `active`, and retirement
-- locks it FOR UPDATE before counting occupants, so a retirement and an incoming move are
-- serialised whichever starts first (T28 builds moves on this contract).
--
-- Print queue: a job now names its target type. Storage-unit jobs keep print_job_item exactly as
-- before; location jobs list their labels in print_job_location_item with the code and name as
-- they were requested. No fake storage unit or receipt ever stands in for a location.

ALTER TABLE location
  ADD COLUMN area text
    CONSTRAINT location_area_check
    CHECK (area = btrim(area) AND length(area) BETWEEN 1 AND 60),
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_reason text
    CONSTRAINT location_retired_reason_check
    CHECK (length(btrim(retired_reason)) BETWEEN 1 AND 500),
  ADD COLUMN code_locked_at timestamptz,
  ADD COLUMN label_printed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CONSTRAINT location_version_check CHECK (version >= 1);

-- Locations made inactive before this card have no recorded retirement: give them one so the
-- pairing rule below holds.
UPDATE location
SET retired_at = created_at, retired_reason = 'Retired before location administration existed'
WHERE NOT active;

ALTER TABLE location
  -- Retired exactly when inactive, with a reason.
  ADD CONSTRAINT location_retirement_check CHECK (
    active = (retired_at IS NULL) AND (retired_at IS NULL) = (retired_reason IS NULL)
  ),
  -- A physical confirmation implies the code was locked by a print request.
  ADD CONSTRAINT location_label_printed_check CHECK (
    label_printed_at IS NULL OR code_locked_at IS NOT NULL
  );

CREATE INDEX location_name_idx ON location (lower(name));

-- Integrity rules the application also checks, enforced here so a bug can't break them.
CREATE FUNCTION location_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Locations are retired, never deleted: history, audit and print jobs keep naming them.
    RAISE EXCEPTION 'location % can''t be deleted; retire it instead', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'location % system flag can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.is_system AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'system location % kind can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.code_locked_at IS NOT NULL AND (
    NEW.code IS DISTINCT FROM OLD.code OR NEW.code_locked_at IS DISTINCT FROM OLD.code_locked_at
  ) THEN
    RAISE EXCEPTION 'location % code is locked: a label has been requested for it', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.label_printed_at IS NOT NULL AND NEW.label_printed_at IS DISTINCT FROM OLD.label_printed_at THEN
    RAISE EXCEPTION 'location % first physical label confirmation can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_guard
  BEFORE UPDATE OR DELETE ON location
  FOR EACH ROW EXECUTE FUNCTION location_guard();

-- Units are only ever placed in an active location. Locking the destination row makes this wait
-- for a retirement in progress (which holds FOR UPDATE) and then see its result; a retirement
-- that starts second waits for this transaction and then counts the unit as an occupant.
CREATE FUNCTION storage_unit_location_must_be_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  destination_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_location_id IS NOT DISTINCT FROM OLD.current_location_id THEN
    RETURN NEW;
  END IF;
  SELECT active INTO destination_active
  FROM location WHERE id = NEW.current_location_id
  FOR KEY SHARE;
  IF destination_active IS FALSE THEN
    RAISE EXCEPTION 'location is retired; storage units can''t be placed there'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_location_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_location_active
  BEFORE INSERT OR UPDATE OF current_location_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_location_must_be_active();

-- ---------------------------------------------------------------------------------------------
-- Print queue: location targets
-- ---------------------------------------------------------------------------------------------

ALTER TABLE print_job
  ADD COLUMN target_type text NOT NULL DEFAULT 'storage_unit'
    CONSTRAINT print_job_target_type_check CHECK (target_type IN ('storage_unit', 'location'));

CREATE TABLE print_job_location_item (
  print_job_id   uuid NOT NULL REFERENCES print_job (id),
  location_id    uuid NOT NULL REFERENCES location (id),
  position       integer NOT NULL CHECK (position >= 1),
  -- What the label carries, as requested: the payload is 'LOC-' || code_snapshot. The code is
  -- locked from the request on, so it always equals the location's code; the name may be renamed
  -- later and history keeps the name that was printed.
  code_snapshot  text NOT NULL CHECK (code_snapshot ~ '^[A-Z0-9-]{2,20}$'),
  name_snapshot  text NOT NULL CHECK (length(btrim(name_snapshot)) BETWEEN 1 AND 100),
  PRIMARY KEY (print_job_id, location_id),
  UNIQUE (print_job_id, position)
);
CREATE INDEX print_job_location_item_location_idx ON print_job_location_item (location_id);

-- Items must match their job's target type, a location label must carry the location's own
-- (locked) code, and a job's target type never changes.
CREATE FUNCTION print_job_item_matches_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  job_target text;
  location_code text;
  location_locked timestamptz;
BEGIN
  SELECT target_type INTO job_target FROM print_job WHERE id = NEW.print_job_id;
  IF TG_TABLE_NAME = 'print_job_item' THEN
    IF job_target IS DISTINCT FROM 'storage_unit' THEN
      RAISE EXCEPTION 'print job % is not a storage-unit job', NEW.print_job_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF job_target IS DISTINCT FROM 'location' THEN
    RAISE EXCEPTION 'print job % is not a location job', NEW.print_job_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT code_normalized, code_locked_at INTO location_code, location_locked
  FROM location WHERE id = NEW.location_id;
  IF location_locked IS NULL OR location_code IS DISTINCT FROM NEW.code_snapshot THEN
    RAISE EXCEPTION 'location label must carry the location''s locked code'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_item_target
  BEFORE INSERT OR UPDATE ON print_job_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_matches_target();

CREATE TRIGGER print_job_location_item_target
  BEFORE INSERT OR UPDATE ON print_job_location_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_matches_target();

CREATE FUNCTION print_job_target_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'print job % target type can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_target_immutable
  BEFORE UPDATE OF target_type ON print_job
  FOR EACH ROW EXECUTE FUNCTION print_job_target_is_immutable();
