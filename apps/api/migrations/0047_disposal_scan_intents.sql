-- STRATA-92: Disposal scan-out intents. A scan taken on a computer (online, or queued offline) is
-- an intent with its own UUID. Recording an intent writes one row here, in the same transaction as
-- what it did, so a retry with the same intent ID returns the outcome first recorded and never adds
-- a second history entry (a refusal is audited once, a disposal recorded once).
--
-- * intent_id is the scanning computer's UUID; for a disposal it is also the disposal_removal
--   idempotency key;
-- * user_id is the personal account that recorded it (never the shared LAB account);
-- * request_hash is what was scanned (normalised), so the same ID can't be reused for another unit;
-- * result/outcome is what recording did; not_found has no unit, every other result has one;
-- * a disposed intent matches its disposal_removal row (same key, unit and remover).
-- Rows are never changed or deleted.

CREATE TABLE disposal_scan_intent (
  intent_id        uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES app_user (id),
  request_hash     text NOT NULL,
  storage_unit_id  uuid REFERENCES storage_unit (id),
  result           text NOT NULL
                   CHECK (result IN ('disposed', 'not_approved', 'blocked', 'not_found')),
  outcome          jsonb NOT NULL,
  scanned_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disposal_scan_intent_unit_check
    CHECK ((result = 'not_found') = (storage_unit_id IS NULL))
);

CREATE INDEX disposal_scan_intent_unit_idx ON disposal_scan_intent (storage_unit_id);

CREATE TRIGGER disposal_scan_intent_append_only
  BEFORE UPDATE OR DELETE ON disposal_scan_intent
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

CREATE FUNCTION disposal_scan_intent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT account_type FROM app_user WHERE id = NEW.user_id) = 'shared_lab' THEN
    RAISE EXCEPTION 'a disposal scan is recorded by a personal account, never by LAB'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_scan_intent_account_check';
  END IF;
  IF NEW.result = 'disposed' AND NOT EXISTS (
       SELECT 1 FROM disposal_removal r
       WHERE r.idempotency_key = NEW.intent_id AND r.storage_unit_id = NEW.storage_unit_id
         AND r.removed_by_user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'a disposed intent needs its disposal record'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_scan_intent_removal_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_scan_intent_guard
  BEFORE INSERT ON disposal_scan_intent
  FOR EACH ROW EXECUTE FUNCTION disposal_scan_intent_guard();
