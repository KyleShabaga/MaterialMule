-- MM-T28: destination scans, queued moves and location conflicts.
--
-- Three tables, all append-or-settle (never deleted):
-- * movement_event: every move attempt the server accepted, whether it changed the saved location
--   ('move'), was held because the unit had changed since the scan ('contested') or was a person
--   confirming the actual location to settle a conflict ('resolution'). Scan time is what the
--   device reported; saved_at is the server's clock. Device time never decides anything.
-- * location_conflict: a unit whose actual location needs a person to confirm it. At most one is
--   open per unit; later contested attempts join it (its version goes up) until it is resolved.
-- * move_action: the durable idempotency record of each client move intent (client_move_id, a
--   UUID the browser generates once per scan). It stores the outcome so a retry after a lost
--   response gets the original answer, and the account so no other account can adopt or read it.
--
-- Lock order (documented in docs/database.md): storage_unit FOR UPDATE, then the destination
-- location FOR KEY SHARE (the 0028 trigger does the same), then location_conflict FOR UPDATE.
-- Corrections lock the unit first too, and location retirement locks only the location, so a
-- move and a retirement serialise on the location row without deadlocking.

CREATE TABLE location_conflict (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- Bumped whenever an attempt joins or the conflict is resolved; resolve requests send it.
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  -- The unit's saved location and version when the conflict opened.
  saved_location_id           uuid NOT NULL REFERENCES location (id),
  saved_version               integer NOT NULL CHECK (saved_version >= 1),
  resolved_at                 timestamptz,
  resolved_by_user_id         uuid REFERENCES app_user (id),
  resolved_by_initials_snapshot text,
  resolved_by_name_snapshot   text,
  resolved_location_id        uuid REFERENCES location (id),
  resolution_note             text CHECK (length(btrim(resolution_note)) BETWEEN 1 AND 500),
  client_resolution_id        uuid UNIQUE,
  resolution_request_hash     text,
  CONSTRAINT location_conflict_resolution_check CHECK (
    (status = 'open') = (resolved_at IS NULL)
    AND (resolved_at IS NULL) = (resolved_by_user_id IS NULL)
    AND (resolved_at IS NULL) = (resolved_location_id IS NULL)
    AND (resolved_at IS NULL) = (client_resolution_id IS NULL)
    AND (client_resolution_id IS NULL) = (resolution_request_hash IS NULL)
  )
);
CREATE UNIQUE INDEX location_conflict_one_open_idx
  ON location_conflict (storage_unit_id) WHERE status = 'open';
CREATE INDEX location_conflict_unit_idx ON location_conflict (storage_unit_id, opened_at DESC);

CREATE TABLE movement_event (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  kind                        text NOT NULL CHECK (kind IN ('move', 'contested', 'resolution')),
  -- Saved location when the server handled it, and where the scan (or the person) put it.
  from_location_id            uuid NOT NULL REFERENCES location (id),
  to_location_id              uuid NOT NULL REFERENCES location (id),
  -- The version the scan was based on, and the unit's version after this event (null when the
  -- event changed nothing: a contested attempt).
  base_version                integer CHECK (base_version >= 1),
  resulting_version           integer CHECK (resulting_version >= 1),
  -- The signed-in account that saved it (from the session, never from the request).
  actor_user_id               uuid NOT NULL REFERENCES app_user (id),
  actor_account_type          text NOT NULL CHECK (actor_account_type IN ('personal', 'shared_lab', 'test')),
  actor_initials_snapshot     text,
  actor_name_snapshot         text NOT NULL,
  -- Staff member credited at a LAB station, as they were when the move was saved.
  mover_user_id               uuid REFERENCES app_user (id),
  mover_initials_snapshot     text,
  mover_name_snapshot         text,
  -- Reported by the browser: a random per-browser-profile ID (not a session) and its clock.
  station_id                  uuid,
  scanned_at                  timestamptz,
  saved_at                    timestamptz NOT NULL DEFAULT now(),
  source                      text NOT NULL CHECK (source IN ('online', 'queued', 'resolution')),
  client_move_id              uuid UNIQUE,
  conflict_id                 uuid REFERENCES location_conflict (id),
  note                        text CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  CONSTRAINT movement_event_shape_check CHECK (
    CASE kind
      WHEN 'move' THEN client_move_id IS NOT NULL AND resulting_version IS NOT NULL
                       AND base_version IS NOT NULL AND scanned_at IS NOT NULL
                       AND source IN ('online', 'queued')
      WHEN 'contested' THEN client_move_id IS NOT NULL AND resulting_version IS NULL
                            AND base_version IS NOT NULL AND scanned_at IS NOT NULL
                            AND conflict_id IS NOT NULL AND source IN ('online', 'queued')
      WHEN 'resolution' THEN client_move_id IS NULL AND resulting_version IS NOT NULL
                             AND conflict_id IS NOT NULL AND source = 'resolution'
    END
  ),
  CONSTRAINT movement_event_mover_check CHECK (
    (mover_user_id IS NULL) = (mover_name_snapshot IS NULL)
  )
);
CREATE INDEX movement_event_unit_idx ON movement_event (storage_unit_id, saved_at DESC);
CREATE INDEX movement_event_conflict_idx ON movement_event (conflict_id) WHERE conflict_id IS NOT NULL;

CREATE TABLE move_action (
  client_move_id              uuid PRIMARY KEY,
  -- Only this account may replay the action or read its outcome.
  account_user_id             uuid NOT NULL REFERENCES app_user (id),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  station_id                  uuid NOT NULL,
  previous_client_move_id     uuid REFERENCES move_action (client_move_id),
  -- SHA-256 of the validated business intent (no cookies, sessions or retry counters).
  request_hash                text NOT NULL,
  outcome                     text NOT NULL CHECK (outcome IN ('saved', 'conflict')),
  movement_event_id           uuid NOT NULL UNIQUE REFERENCES movement_event (id),
  conflict_id                 uuid REFERENCES location_conflict (id),
  -- Saved: the unit's version after the move. Conflict: its version when the attempt was held.
  resulting_version           integer NOT NULL CHECK (resulting_version >= 1),
  applied_to_location_id      uuid REFERENCES location (id),
  saved_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT move_action_not_self_check CHECK (previous_client_move_id <> client_move_id),
  CONSTRAINT move_action_result_check CHECK (
    (outcome = 'saved' AND conflict_id IS NULL AND applied_to_location_id IS NOT NULL)
    OR (outcome = 'conflict' AND conflict_id IS NOT NULL AND applied_to_location_id IS NULL)
  )
);
CREATE INDEX move_action_unit_idx ON move_action (storage_unit_id);

-- History is append-only: no movement event or recorded action outcome changes or disappears.
-- A conflict changes only from open to resolved (and its version), and only once.
CREATE FUNCTION movement_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER movement_event_append_only
  BEFORE UPDATE OR DELETE ON movement_event
  FOR EACH ROW EXECUTE FUNCTION movement_history_is_append_only();

CREATE TRIGGER move_action_append_only
  BEFORE UPDATE OR DELETE ON move_action
  FOR EACH ROW EXECUTE FUNCTION movement_history_is_append_only();

CREATE FUNCTION location_conflict_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'location conflicts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'location conflict % is resolved and can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.storage_unit_id IS DISTINCT FROM OLD.storage_unit_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.saved_location_id IS DISTINCT FROM OLD.saved_location_id
     OR NEW.saved_version IS DISTINCT FROM OLD.saved_version
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'location conflict % can only gain attempts or be resolved', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_conflict_guard
  BEFORE UPDATE OR DELETE ON location_conflict
  FOR EACH ROW EXECUTE FUNCTION location_conflict_guard();

-- A disposed unit never moves (D28; T36 tested-tube removal, T30 disposal scans). Its last saved
-- location stays as history, so only a change of location is refused.
CREATE FUNCTION storage_unit_disposed_stays_put() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disposed' AND NEW.current_location_id IS DISTINCT FROM OLD.current_location_id THEN
    RAISE EXCEPTION 'storage unit % is disposed and can''t move', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_stays_put';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_stays_put
  BEFORE UPDATE OF current_location_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_stays_put();
