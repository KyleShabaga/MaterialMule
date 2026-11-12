-- STRATA-123 (Strata redesign, lane 1C): audited Undo of a saved move. An undo never deletes or
-- edits history: it is a new 'move' movement event (through the normal move rules and locks)
-- that takes the unit back to where the original move found it, linked here to the original.
--
-- One row per undone move:
-- * an original is undone at most once (primary key);
-- * a reversal reverses exactly one original (unique), and is never itself undone: undo of an
--   undo is not allowed (the person makes a new move instead), so no reversal is ever an original
--   and no original is ever a reversal;
-- * both events are saved moves of the same unit by the same account, the reversal goes exactly
--   back (from the original's destination to its origin) and starts from the version the
--   original left;
-- * the idempotency key is the reversal's client_move_id, so a retry finds its first result.
-- Rows are append-only, like movement_event and move_action.

CREATE TABLE movement_reversal (
  original_event_id   uuid PRIMARY KEY REFERENCES movement_event (id),
  reversal_event_id   uuid NOT NULL UNIQUE REFERENCES movement_event (id),
  idempotency_key     uuid NOT NULL UNIQUE,
  -- The account that saved both events (the shared LAB account at a LAB station).
  account_user_id     uuid NOT NULL REFERENCES app_user (id),
  undone_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movement_reversal_not_self_check CHECK (original_event_id <> reversal_event_id)
);

CREATE FUNCTION movement_reversal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original movement_event%ROWTYPE;
  reversal movement_event%ROWTYPE;
BEGIN
  -- No undo of an undo, and no reversal reused as an original.
  IF EXISTS (SELECT 1 FROM movement_reversal WHERE reversal_event_id = NEW.original_event_id)
     OR EXISTS (SELECT 1 FROM movement_reversal WHERE original_event_id = NEW.reversal_event_id) THEN
    RAISE EXCEPTION 'an undo can''t be undone'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_reversal_chain_check';
  END IF;
  SELECT * INTO original FROM movement_event WHERE id = NEW.original_event_id;
  SELECT * INTO reversal FROM movement_event WHERE id = NEW.reversal_event_id;
  IF original.kind <> 'move' OR reversal.kind <> 'move' THEN
    RAISE EXCEPTION 'only a saved move is undone, by a saved move'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_reversal_kind_check';
  END IF;
  IF original.from_location_id = original.to_location_id
     OR reversal.storage_unit_id <> original.storage_unit_id
     OR reversal.from_location_id <> original.to_location_id
     OR reversal.to_location_id <> original.from_location_id
     OR reversal.base_version <> original.resulting_version
     OR reversal.saved_at < original.saved_at THEN
    RAISE EXCEPTION 'a reversal takes the same unit straight back from the original''s result'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_reversal_shape_check';
  END IF;
  IF original.actor_user_id <> NEW.account_user_id
     OR reversal.actor_user_id <> NEW.account_user_id
     OR original.mover_user_id IS DISTINCT FROM reversal.mover_user_id THEN
    RAISE EXCEPTION 'only the account (and LAB person) that saved a move undoes it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_reversal_actor_check';
  END IF;
  IF reversal.client_move_id IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'the idempotency key is the reversal''s client move ID'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_reversal_key_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER movement_reversal_check
  BEFORE INSERT ON movement_reversal
  FOR EACH ROW EXECUTE FUNCTION movement_reversal_check();

CREATE TRIGGER movement_reversal_append_only
  BEFORE UPDATE OR DELETE ON movement_reversal
  FOR EACH ROW EXECUTE FUNCTION movement_history_is_append_only();
