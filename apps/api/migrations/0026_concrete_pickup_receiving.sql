-- MM-V2-C06: specimen pickup and initial curing, the Pick up window, lab receipt with one
-- unmoulded mass in grams, mass corrections, per-set permanent-marker confirmation, receiving
-- exceptions (missing / extra / unmatched) and the standards-based curing-range reference.
-- Adds tables only; changes no existing row and touches nothing of storage-unit receiving.
--
-- Source: combined plan field-sheet rows "Pickup", "Initial curing", "Receiving", the Receiving
-- screen, "Missing, extra or separately arriving" and "Unreadable or unmatched marker IDs";
-- spec page 5 (CD-29–CD-34, CD-46). Pending, deliberately not defaulted: CSA/ASTM pickup window
-- bounds and initial-curing limits (CD-62). No range is seeded: until a Lab Manager or admin
-- configures one, curing readings are stored unchecked, never compared with a guessed range.
--
-- Attribution: every event names the actual person (collector, receiver, confirming person) and
-- the signed-in account that recorded it (which may be the shared LAB account). The person is a
-- personal or test account, never LAB; naming them grants nothing.

-- ---------------------------------------------------------------------------------------------
-- Curing-range reference (CD-32): global, standards-based, never per project
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_curing_standard (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The governing specification and edition, e.g. as written in the standard (text, not guessed).
  specification        text NOT NULL
                         CONSTRAINT concrete_curing_standard_specification_check
                         CHECK (length(btrim(specification)) BETWEEN 1 AND 200),
  edition              text NOT NULL
                         CONSTRAINT concrete_curing_standard_edition_check
                         CHECK (length(btrim(edition)) BETWEEN 1 AND 100),
  min_c                numeric(3, 1) NOT NULL,
  max_c                numeric(3, 1) NOT NULL,
  note                 text CONSTRAINT concrete_curing_standard_note_check
                         CHECK (length(note) <= 2000),
  created_by_user_id   uuid NOT NULL REFERENCES app_user (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Superseded by a later range. A range applied to a pickup is kept for its history.
  retired_at           timestamptz,
  retired_by_user_id   uuid REFERENCES app_user (id),
  CONSTRAINT concrete_curing_standard_range CHECK (min_c < max_c),
  CONSTRAINT concrete_curing_standard_retired_shape
    CHECK ((retired_at IS NULL) = (retired_by_user_id IS NULL))
);
-- At most one range applies at a time.
CREATE UNIQUE INDEX concrete_curing_standard_one_current
  ON concrete_curing_standard ((true)) WHERE retired_at IS NULL;
CREATE INDEX concrete_curing_standard_created_by_idx ON concrete_curing_standard (created_by_user_id);
CREATE INDEX concrete_curing_standard_retired_by_idx
  ON concrete_curing_standard (retired_by_user_id) WHERE retired_by_user_id IS NOT NULL;

-- A configured range never changes its values (a change is a new row); it is only retired, once.
CREATE FUNCTION concrete_curing_standard_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
       AND (to_jsonb(NEW) - 'retired_at' - 'retired_by_user_id')
           = (to_jsonb(OLD) - 'retired_at' - 'retired_by_user_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a concrete curing range is kept as configured; add a new one instead'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_curing_standard_fixed';
END;
$$;
CREATE TRIGGER concrete_curing_standard_guard
  BEFORE UPDATE OR DELETE ON concrete_curing_standard
  FOR EACH ROW EXECUTE FUNCTION concrete_curing_standard_guard();
CREATE TRIGGER concrete_curing_standard_no_truncate
  BEFORE TRUNCATE ON concrete_curing_standard
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_curing_standard_guard();

-- The person credited with a pickup, receipt or confirmation: an active personal or test
-- account, checked when it is set or changed (a later disable doesn't rewrite history).
CREATE FUNCTION concrete_receiving_person_ok(person uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT person IS NULL OR EXISTS (
      SELECT 1 FROM app_user u
      WHERE u.id = person AND u.status = 'active' AND u.account_type IN ('personal', 'test'))
  $$;

-- ---------------------------------------------------------------------------------------------
-- Pick up window (estimate only)
-- ---------------------------------------------------------------------------------------------

-- A set's Pick up window when someone edited it: hours from the report's casting time. Without a
-- row the window is the 24-hour starting default (shared CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS),
-- not a verified deadline (CD-62). Never used to fill an actual pickup.
CREATE TABLE concrete_set_pickup_window (
  set_id              uuid PRIMARY KEY,
  project_id          uuid NOT NULL,
  hours               integer NOT NULL
                        CONSTRAINT concrete_set_pickup_window_hours_check CHECK (hours BETWEEN 1 AND 336),
  updated_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1
                        CONSTRAINT concrete_set_pickup_window_version_check CHECK (version >= 1),
  CONSTRAINT concrete_set_pickup_window_set_fkey FOREIGN KEY (project_id, set_id)
    REFERENCES concrete_specimen_set (project_id, id) ON UPDATE CASCADE
);
CREATE INDEX concrete_set_pickup_window_user_idx ON concrete_set_pickup_window (updated_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- Pickup and initial curing, per specimen
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_specimen_pickup (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL,
  specimen_id                 uuid NOT NULL,
  -- Actual collection (never filled from the Pick up window or the receipt).
  collected_by_user_id        uuid REFERENCES app_user (id),
  collected_at                timestamptz,
  curing_min_c                numeric(3, 1),
  curing_max_c                numeric(3, 1),
  curing_box                  text CONSTRAINT concrete_specimen_pickup_box_check
                                CHECK (length(btrim(curing_box)) BETWEEN 1 AND 100),
  curing_location             text CONSTRAINT concrete_specimen_pickup_location_check
                                CHECK (length(btrim(curing_location)) BETWEEN 1 AND 200),
  -- Completed: all four of collector, date/time, minimum and maximum are recorded (AC1).
  completed                   boolean NOT NULL DEFAULT false,
  -- The range applied when the readings were checked: the reference and a copy of its bounds,
  -- so a later range never rewrites this check. NULL: no range configured (not checked).
  curing_standard_id          uuid REFERENCES concrete_curing_standard (id),
  curing_range_min_c          numeric(3, 1),
  curing_range_max_c          numeric(3, 1),
  -- Out-of-range flags (CD-32): never block pickup, receipt or submission; an issuance gate.
  curing_flags                text[],
  curing_resolved_at          timestamptz,
  curing_resolved_by_user_id  uuid REFERENCES app_user (id),
  curing_resolution_note      text CONSTRAINT concrete_specimen_pickup_resolution_note_check
                                CHECK (length(btrim(curing_resolution_note)) BETWEEN 1 AND 2000),
  recorded_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1
                                CONSTRAINT concrete_specimen_pickup_version_check CHECK (version >= 1),
  CONSTRAINT concrete_specimen_pickup_specimen_key UNIQUE (specimen_id),
  CONSTRAINT concrete_specimen_pickup_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_specimen_pickup_complete CHECK (
    NOT completed OR (collected_by_user_id IS NOT NULL AND collected_at IS NOT NULL
                      AND curing_min_c IS NOT NULL AND curing_max_c IS NOT NULL)
  ),
  CONSTRAINT concrete_specimen_pickup_min_max CHECK (curing_min_c <= curing_max_c),
  CONSTRAINT concrete_specimen_pickup_check_shape CHECK (
    (curing_standard_id IS NULL AND curing_range_min_c IS NULL AND curing_range_max_c IS NULL
       AND curing_flags IS NULL)
    OR (curing_standard_id IS NOT NULL AND curing_range_min_c IS NOT NULL
        AND curing_range_max_c IS NOT NULL AND curing_flags IS NOT NULL
        AND curing_min_c IS NOT NULL AND curing_max_c IS NOT NULL
        AND curing_flags <@ ARRAY['min_below_range', 'max_above_range']::text[])
  ),
  -- The flags are exactly what the readings and the applied range say.
  CONSTRAINT concrete_specimen_pickup_flags_match CHECK (
    curing_flags IS NULL OR (
      ('min_below_range' = ANY (curing_flags)) = (curing_min_c < curing_range_min_c)
      AND ('max_above_range' = ANY (curing_flags)) = (curing_max_c > curing_range_max_c)
      AND cardinality(curing_flags) = (CASE WHEN curing_min_c < curing_range_min_c THEN 1 ELSE 0 END
                                       + CASE WHEN curing_max_c > curing_range_max_c THEN 1 ELSE 0 END)
    )
  ),
  CONSTRAINT concrete_specimen_pickup_resolution_shape CHECK (
    (curing_resolved_at IS NULL AND curing_resolved_by_user_id IS NULL
       AND curing_resolution_note IS NULL)
    OR (curing_resolved_at IS NOT NULL AND curing_resolved_by_user_id IS NOT NULL
        AND curing_resolution_note IS NOT NULL AND coalesce(cardinality(curing_flags), 0) > 0)
  )
);
CREATE INDEX concrete_specimen_pickup_project_idx ON concrete_specimen_pickup (project_id);
CREATE INDEX concrete_specimen_pickup_collector_idx ON concrete_specimen_pickup (collected_by_user_id);
CREATE INDEX concrete_specimen_pickup_recorded_by_idx ON concrete_specimen_pickup (recorded_by_user_id);
CREATE INDEX concrete_specimen_pickup_standard_idx
  ON concrete_specimen_pickup (curing_standard_id) WHERE curing_standard_id IS NOT NULL;
CREATE INDEX concrete_specimen_pickup_resolved_by_idx
  ON concrete_specimen_pickup (curing_resolved_by_user_id) WHERE curing_resolved_by_user_id IS NOT NULL;

CREATE FUNCTION concrete_specimen_pickup_person_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.collected_by_user_id IS DISTINCT FROM OLD.collected_by_user_id)
     AND NOT concrete_receiving_person_ok(NEW.collected_by_user_id) THEN
    RAISE EXCEPTION 'a specimen collector must be an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_pickup_person_check';
  END IF;
  -- A curing flag is resolved by a person on a personal account (never LAB).
  IF (TG_OP = 'INSERT' OR NEW.curing_resolved_by_user_id IS DISTINCT FROM OLD.curing_resolved_by_user_id)
     AND NOT concrete_receiving_person_ok(NEW.curing_resolved_by_user_id) THEN
    RAISE EXCEPTION 'a curing flag is resolved from an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_pickup_person_check';
  END IF;
  -- The copied bounds are the referenced range's bounds.
  IF NEW.curing_standard_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM concrete_curing_standard c
       WHERE c.id = NEW.curing_standard_id AND c.min_c = NEW.curing_range_min_c
         AND c.max_c = NEW.curing_range_max_c) THEN
    RAISE EXCEPTION 'a pickup copies the bounds of the range it was checked against'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_pickup_range_copy';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_pickup_person_check
  BEFORE INSERT OR UPDATE ON concrete_specimen_pickup
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_pickup_person_check();

-- A pickup record is never deleted (its history stays); a resolved flag stays resolved while the
-- readings it resolved are unchanged.
CREATE FUNCTION concrete_specimen_pickup_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'concrete pickup records are kept' USING ERRCODE = 'restrict_violation',
      CONSTRAINT = 'concrete_specimen_pickup_kept';
  END IF;
  IF NEW.specimen_id IS DISTINCT FROM OLD.specimen_id
     OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id THEN
    RAISE EXCEPTION 'pickup % keeps its specimen and recording account', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_pickup_kept';
  END IF;
  IF OLD.curing_resolved_at IS NOT NULL AND NEW.curing_resolved_at IS NULL
     AND NEW.curing_min_c IS NOT DISTINCT FROM OLD.curing_min_c
     AND NEW.curing_max_c IS NOT DISTINCT FROM OLD.curing_max_c THEN
    RAISE EXCEPTION 'pickup % keeps its curing resolution', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_pickup_kept';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_pickup_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_pickup
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_pickup_guard();
CREATE TRIGGER concrete_specimen_pickup_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_pickup
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_pickup_guard();

-- ---------------------------------------------------------------------------------------------
-- Lab receipt: one unmoulded mass in grams to 0.1 g, per specimen
-- ---------------------------------------------------------------------------------------------

-- Saving a receipt with its mass is what marks a specimen received (no separate status column).
CREATE TABLE concrete_specimen_receipt (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL,
  specimen_id          uuid NOT NULL,
  received_at          timestamptz NOT NULL,
  received_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  -- Without the mould (decision 3). numeric keeps the exact entered tenth of a gram; the API
  -- refuses more than one decimal rather than rounding.
  mass_g               numeric(7, 1) NOT NULL
                         CONSTRAINT concrete_specimen_receipt_mass_check CHECK (mass_g > 0),
  recorded_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  -- Set from a resolved extra / unmatched record whose receipt this is (linked after the fact).
  from_exception_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1
                         CONSTRAINT concrete_specimen_receipt_version_check CHECK (version >= 1),
  CONSTRAINT concrete_specimen_receipt_specimen_key UNIQUE (specimen_id),
  CONSTRAINT concrete_specimen_receipt_specimen_id_key UNIQUE (specimen_id, id),
  CONSTRAINT concrete_specimen_receipt_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE
);
CREATE INDEX concrete_specimen_receipt_project_idx ON concrete_specimen_receipt (project_id, received_at);
CREATE INDEX concrete_specimen_receipt_receiver_idx ON concrete_specimen_receipt (received_by_user_id);
CREATE INDEX concrete_specimen_receipt_recorded_by_idx ON concrete_specimen_receipt (recorded_by_user_id);

-- Mass corrections after save (CD-46): personal account, reason; append-only history. The
-- receipt's mass changes only together with a correction row in the same transaction.
CREATE TABLE concrete_specimen_mass_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  specimen_id           uuid NOT NULL,
  receipt_id            uuid NOT NULL,
  previous_mass_g       numeric(7, 1) NOT NULL,
  new_mass_g            numeric(7, 1) NOT NULL
                          CONSTRAINT concrete_specimen_mass_correction_mass_check CHECK (new_mass_g > 0),
  reason                text NOT NULL
                          CONSTRAINT concrete_specimen_mass_correction_reason_check
                          CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  corrected_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  idempotency_key       uuid NOT NULL UNIQUE,
  request_hash          text NOT NULL,
  transaction_id        bigint NOT NULL DEFAULT txid_current(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_specimen_mass_correction_specimen_fkey FOREIGN KEY (project_id, specimen_id)
    REFERENCES concrete_specimen (project_id, id) ON UPDATE CASCADE,
  -- The receipt corrected is that specimen's.
  CONSTRAINT concrete_specimen_mass_correction_receipt_fkey FOREIGN KEY (specimen_id, receipt_id)
    REFERENCES concrete_specimen_receipt (specimen_id, id),
  CONSTRAINT concrete_specimen_mass_correction_changes CHECK (previous_mass_g <> new_mass_g)
);
CREATE INDEX concrete_specimen_mass_correction_specimen_idx
  ON concrete_specimen_mass_correction (specimen_id, created_at);
CREATE INDEX concrete_specimen_mass_correction_receipt_idx ON concrete_specimen_mass_correction (receipt_id);
CREATE INDEX concrete_specimen_mass_correction_user_idx
  ON concrete_specimen_mass_correction (corrected_by_user_id);

CREATE FUNCTION concrete_specimen_receipt_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'concrete receipts are kept' USING ERRCODE = 'restrict_violation',
      CONSTRAINT = 'concrete_specimen_receipt_kept';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.received_by_user_id IS DISTINCT FROM OLD.received_by_user_id)
     AND NOT concrete_receiving_person_ok(NEW.received_by_user_id) THEN
    RAISE EXCEPTION 'a specimen receiver must be an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_receipt_person_check';
  END IF;
  -- A receipt carried over from an extra / unmatched record: resolved, of the same project, and
  -- confirmed as exactly this specimen.
  IF TG_OP = 'INSERT' AND NEW.from_exception_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM concrete_receiving_exception e
       WHERE e.id = NEW.from_exception_id AND e.resolved_at IS NOT NULL
         AND e.project_id = NEW.project_id AND e.matched_specimen_id = NEW.specimen_id) THEN
    RAISE EXCEPTION 'a linked receipt comes from a resolved record matched to this specimen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_receipt_exception_check';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.specimen_id IS DISTINCT FROM OLD.specimen_id
       OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.received_by_user_id IS DISTINCT FROM OLD.received_by_user_id
       OR NEW.from_exception_id IS DISTINCT FROM OLD.from_exception_id THEN
      RAISE EXCEPTION 'receipt % keeps its receipt facts', OLD.id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_receipt_kept';
    END IF;
    IF NEW.mass_g IS DISTINCT FROM OLD.mass_g AND NOT EXISTS (
         SELECT 1 FROM concrete_specimen_mass_correction c
         WHERE c.receipt_id = OLD.id AND c.transaction_id = txid_current()
           AND c.previous_mass_g = OLD.mass_g AND c.new_mass_g = NEW.mass_g) THEN
      RAISE EXCEPTION 'receipt % changes its mass only through a recorded correction', OLD.id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_mass_correction_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_receipt_check
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_specimen_receipt
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_receipt_check();
CREATE TRIGGER concrete_specimen_receipt_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_receipt_check();

-- ---------------------------------------------------------------------------------------------
-- Permanent-marker confirmation, per set, covering the specimens received so far
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_set_marker_confirmation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL,
  set_id                uuid NOT NULL,
  confirmed_at          timestamptz NOT NULL,
  confirmed_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  recorded_by_user_id   uuid NOT NULL REFERENCES app_user (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_set_marker_confirmation_set_fkey FOREIGN KEY (project_id, set_id)
    REFERENCES concrete_specimen_set (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_set_marker_confirmation_set_id_key UNIQUE (set_id, id)
);
CREATE INDEX concrete_set_marker_confirmation_project_idx ON concrete_set_marker_confirmation (project_id);
CREATE INDEX concrete_set_marker_confirmation_confirmed_by_idx
  ON concrete_set_marker_confirmation (confirmed_by_user_id);
CREATE INDEX concrete_set_marker_confirmation_recorded_by_idx
  ON concrete_set_marker_confirmation (recorded_by_user_id);

-- Which specimens a confirmation covers: each specimen once, of the same set, received by then.
CREATE TABLE concrete_set_marker_confirmation_specimen (
  confirmation_id  uuid NOT NULL,
  set_id           uuid NOT NULL,
  specimen_id      uuid NOT NULL REFERENCES concrete_specimen (id),
  PRIMARY KEY (confirmation_id, specimen_id),
  CONSTRAINT concrete_set_marker_confirmation_specimen_once UNIQUE (specimen_id),
  CONSTRAINT concrete_set_marker_confirmation_specimen_conf_fkey FOREIGN KEY (set_id, confirmation_id)
    REFERENCES concrete_set_marker_confirmation (set_id, id)
);
CREATE INDEX concrete_set_marker_confirmation_specimen_set_idx
  ON concrete_set_marker_confirmation_specimen (set_id);

CREATE FUNCTION concrete_set_marker_confirmation_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'concrete_set_marker_confirmation' THEN
      IF NOT concrete_receiving_person_ok(NEW.confirmed_by_user_id) THEN
        RAISE EXCEPTION 'the confirming person must be an active personal account'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_set_marker_confirmation_person_check';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM concrete_specimen_set s
                     WHERE s.id = NEW.set_id AND s.permanent_number IS NOT NULL) THEN
        RAISE EXCEPTION 'set % has no permanent ID to mark', NEW.set_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_set_marker_confirmation_numbered';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM concrete_specimen sp
                      JOIN concrete_specimen_receipt r ON r.specimen_id = sp.id
                      WHERE sp.id = NEW.specimen_id AND sp.set_id = NEW.set_id) THEN
      RAISE EXCEPTION 'specimen % is not a received specimen of set %', NEW.specimen_id, NEW.set_id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'concrete_set_marker_confirmation_specimen_received';
    END IF;
    RETURN NEW;
  END IF;
  -- Confirmations are append-only; only a project correction cascading from the set changes one.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'concrete_set_marker_confirmation' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'concrete marker confirmations are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_set_marker_confirmation_append_only';
END;
$$;
CREATE TRIGGER concrete_set_marker_confirmation_check
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_set_marker_confirmation
  FOR EACH ROW EXECUTE FUNCTION concrete_set_marker_confirmation_check();
CREATE TRIGGER concrete_set_marker_confirmation_no_truncate
  BEFORE TRUNCATE ON concrete_set_marker_confirmation
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_set_marker_confirmation_check();
CREATE TRIGGER concrete_set_marker_confirmation_specimen_check
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_set_marker_confirmation_specimen
  FOR EACH ROW EXECUTE FUNCTION concrete_set_marker_confirmation_check();
CREATE TRIGGER concrete_set_marker_confirmation_specimen_no_truncate
  BEFORE TRUNCATE ON concrete_set_marker_confirmation_specimen
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_set_marker_confirmation_check();

-- ---------------------------------------------------------------------------------------------
-- Receiving exceptions (CD-34): missing, extra, unreadable / unmatched
-- ---------------------------------------------------------------------------------------------

-- missing:   an expected specimen that didn't arrive (never removed from its set).
-- extra:     a specimen that arrived but isn't on the set (never silently added to it).
-- unmatched: a specimen whose marking can't be read or matched; receipt kept unresolved.
-- Resolution (concrete_receiving_exception.resolve): the lead, a designated reviewer, a
-- concrete-grant Lab Manager, or the casting technician for specimens they cast; personal
-- account, disposition and reason. It records who, when and why and never edits the original.
CREATE TABLE concrete_receiving_exception (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES project (id),
  kind                   text NOT NULL
                           CONSTRAINT concrete_receiving_exception_kind_check
                           CHECK (kind IN ('missing', 'extra', 'unmatched')),
  -- The set it concerns (missing: the specimen's set; extra: the set it seems to belong to).
  set_id                 uuid,
  specimen_id            uuid REFERENCES concrete_specimen (id),
  -- What was physically seen (marker text, label), kept as written.
  observed_marking       text CONSTRAINT concrete_receiving_exception_marking_check
                           CHECK (length(btrim(observed_marking)) BETWEEN 1 AND 200),
  note                   text CONSTRAINT concrete_receiving_exception_note_check
                           CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  -- Actual receipt of an extra or unmatched specimen, when it was weighed.
  received_at            timestamptz,
  received_by_user_id    uuid REFERENCES app_user (id),
  mass_g                 numeric(7, 1) CONSTRAINT concrete_receiving_exception_mass_check CHECK (mass_g > 0),
  reported_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  recorded_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Resolution.
  resolved_at            timestamptz,
  resolved_by_user_id    uuid REFERENCES app_user (id),
  resolution_source      text CONSTRAINT concrete_receiving_exception_source_check
                           CHECK (resolution_source IN ('lead_project_engineer', 'designated_reviewer',
                                                        'concrete_lab_manager', 'record_technician')),
  disposition            text CONSTRAINT concrete_receiving_exception_disposition_check
                           CHECK (length(btrim(disposition)) BETWEEN 1 AND 200),
  resolution_reason      text CONSTRAINT concrete_receiving_exception_reason_check
                           CHECK (length(btrim(resolution_reason)) BETWEEN 1 AND 2000),
  -- The existing specimen an extra / unmatched record was confirmed to be.
  matched_specimen_id    uuid REFERENCES concrete_specimen (id),
  -- Follows its set through a project correction (ON UPDATE CASCADE).
  CONSTRAINT concrete_receiving_exception_set_fkey FOREIGN KEY (project_id, set_id)
    REFERENCES concrete_specimen_set (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_receiving_exception_kind_shape CHECK (
    CASE kind
      WHEN 'missing' THEN specimen_id IS NOT NULL AND set_id IS NOT NULL AND received_at IS NULL
        AND received_by_user_id IS NULL AND mass_g IS NULL AND matched_specimen_id IS NULL
      ELSE specimen_id IS NULL
        AND (received_at IS NULL) = (received_by_user_id IS NULL)
        AND (mass_g IS NULL OR received_at IS NOT NULL)
    END
  ),
  CONSTRAINT concrete_receiving_exception_resolution_shape CHECK (
    (resolved_at IS NULL AND resolved_by_user_id IS NULL AND resolution_source IS NULL
       AND disposition IS NULL AND resolution_reason IS NULL AND matched_specimen_id IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL AND resolution_source IS NOT NULL
        AND disposition IS NOT NULL AND resolution_reason IS NOT NULL)
  )
);
CREATE INDEX concrete_receiving_exception_project_idx
  ON concrete_receiving_exception (project_id, created_at DESC, id);
CREATE INDEX concrete_receiving_exception_open_idx
  ON concrete_receiving_exception (set_id) WHERE resolved_at IS NULL;
CREATE INDEX concrete_receiving_exception_specimen_idx
  ON concrete_receiving_exception (specimen_id) WHERE specimen_id IS NOT NULL;
CREATE INDEX concrete_receiving_exception_matched_idx
  ON concrete_receiving_exception (matched_specimen_id) WHERE matched_specimen_id IS NOT NULL;
CREATE INDEX concrete_receiving_exception_receiver_idx
  ON concrete_receiving_exception (received_by_user_id) WHERE received_by_user_id IS NOT NULL;
CREATE INDEX concrete_receiving_exception_reported_by_idx ON concrete_receiving_exception (reported_by_user_id);
CREATE INDEX concrete_receiving_exception_recorded_by_idx ON concrete_receiving_exception (recorded_by_user_id);
CREATE INDEX concrete_receiving_exception_resolved_by_idx
  ON concrete_receiving_exception (resolved_by_user_id) WHERE resolved_by_user_id IS NOT NULL;
-- One open missing record per specimen.
CREATE UNIQUE INDEX concrete_receiving_exception_one_open_missing
  ON concrete_receiving_exception (specimen_id) WHERE kind = 'missing' AND resolved_at IS NULL;

ALTER TABLE concrete_specimen_receipt
  ADD CONSTRAINT concrete_specimen_receipt_exception_fkey
    FOREIGN KEY (from_exception_id) REFERENCES concrete_receiving_exception (id);
CREATE INDEX concrete_specimen_receipt_exception_idx
  ON concrete_specimen_receipt (from_exception_id) WHERE from_exception_id IS NOT NULL;

-- The record stays as reported; it is resolved once (personal account), then final.
CREATE FUNCTION concrete_receiving_exception_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  same_set boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'concrete receiving exceptions are kept'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_receiving_exception_kept';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT concrete_receiving_person_ok(NEW.received_by_user_id)
       OR NOT concrete_receiving_person_ok(NEW.reported_by_user_id) THEN
      RAISE EXCEPTION 'receiving exception people must be active personal accounts'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_person_check';
    END IF;
    IF NEW.set_id IS NOT NULL THEN
      SELECT s.project_id = NEW.project_id
             AND (NEW.specimen_id IS NULL OR EXISTS (
               SELECT 1 FROM concrete_specimen sp WHERE sp.id = NEW.specimen_id AND sp.set_id = s.id))
        INTO same_set FROM concrete_specimen_set s WHERE s.id = NEW.set_id;
      IF NOT coalesce(same_set, false) THEN
        RAISE EXCEPTION 'a receiving exception names a set and specimen of its project'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_scope_check';
      END IF;
    END IF;
    IF NEW.kind = 'missing' AND EXISTS (
         SELECT 1 FROM concrete_specimen_receipt r WHERE r.specimen_id = NEW.specimen_id) THEN
      RAISE EXCEPTION 'specimen % was received, so it is not missing', NEW.specimen_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_scope_check';
    END IF;
    IF NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'a receiving exception starts open'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_kept';
    END IF;
    RETURN NEW;
  END IF;
  -- A project correction cascading down.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
    RETURN NEW;
  END IF;
  IF OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['resolved_at', 'resolved_by_user_id', 'resolution_source',
                                'disposition', 'resolution_reason', 'matched_specimen_id'])
         = (to_jsonb(OLD) - ARRAY['resolved_at', 'resolved_by_user_id', 'resolution_source',
                                  'disposition', 'resolution_reason', 'matched_specimen_id']) THEN
    IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = NEW.resolved_by_user_id
                   AND u.status = 'active' AND u.account_type IN ('personal', 'test')) THEN
      RAISE EXCEPTION 'a receiving exception is resolved from a personal account'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_person_check';
    END IF;
    IF NEW.matched_specimen_id IS NOT NULL AND (OLD.kind = 'missing' OR NOT EXISTS (
         SELECT 1 FROM concrete_specimen sp WHERE sp.id = NEW.matched_specimen_id
           AND sp.project_id = OLD.project_id)) THEN
      RAISE EXCEPTION 'only an extra or unmatched record matches a specimen of its project'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_receiving_exception_scope_check';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'receiving exception % is kept as recorded and resolved once', OLD.id
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_receiving_exception_kept';
END;
$$;
CREATE TRIGGER concrete_receiving_exception_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_receiving_exception
  FOR EACH ROW EXECUTE FUNCTION concrete_receiving_exception_guard();
CREATE TRIGGER concrete_receiving_exception_no_truncate
  BEFORE TRUNCATE ON concrete_receiving_exception
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_receiving_exception_guard();

-- Mass-correction history is append-only (project corrections cascade); a correction is made
-- from a personal account (CD-46).
CREATE FUNCTION concrete_specimen_mass_correction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT concrete_receiving_person_ok(NEW.corrected_by_user_id) THEN
      RAISE EXCEPTION 'a mass correction is made from an active personal account'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_specimen_mass_correction_person_check';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'concrete mass corrections are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_specimen_mass_correction_append_only';
END;
$$;
CREATE TRIGGER concrete_specimen_mass_correction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_specimen_mass_correction
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_mass_correction_guard();
CREATE TRIGGER concrete_specimen_mass_correction_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_mass_correction
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_mass_correction_guard();

-- ---------------------------------------------------------------------------------------------
-- Exactly-once receiving commands
-- ---------------------------------------------------------------------------------------------

-- pickup / pickup_window / receipt / marker / exception / resolve: a retried request with the same
-- key and body returns the result as it stands, without a second row or audit event; the same key
-- for anything else is 409 idempotency_key_reused. (Mass corrections key on their own row.)
CREATE TABLE concrete_receiving_command (
  idempotency_key  uuid PRIMARY KEY,
  kind             text NOT NULL
                     CONSTRAINT concrete_receiving_command_kind_check
                     CHECK (kind IN ('pickup', 'pickup_window', 'receipt', 'marker', 'exception',
                                     'resolve', 'curing_resolve')),
  target_id        uuid NOT NULL,
  request_hash     text NOT NULL,
  user_id          uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concrete_receiving_command_target_idx ON concrete_receiving_command (target_id);
CREATE INDEX concrete_receiving_command_user_idx ON concrete_receiving_command (user_id);

CREATE FUNCTION concrete_receiving_command_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete receiving commands are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_receiving_command_append_only';
END;
$$;
CREATE TRIGGER concrete_receiving_command_guard
  BEFORE UPDATE OR DELETE ON concrete_receiving_command
  FOR EACH ROW EXECUTE FUNCTION concrete_receiving_command_guard();
CREATE TRIGGER concrete_receiving_command_no_truncate
  BEFORE TRUNCATE ON concrete_receiving_command
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_receiving_command_guard();
