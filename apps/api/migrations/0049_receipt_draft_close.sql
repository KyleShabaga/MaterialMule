-- Strata lane A: the receipt draft registry (0044) learns when a draft is finished without being
-- deleted by a person, so the LAB station's "Draft receipts to finish" count stops counting it.
--
-- * closed_reason 'confirmed': the draft's receipt was confirmed (recorded in the receipt's own
--   transaction); 'expired': the browser's automatic clean-up (MM-T45) deleted it.
-- * closed_at and closed_reason come together; a draft is registered open, and the close is
--   recorded once: once set, neither ever changes or clears.
-- * A close is not a deletion: deleted_* stay as 0044 defines them, and a deleted row is never
--   closed afterwards (0044's "deletion is recorded once" already refuses every later update).
-- * Every other column keeps 0044's rules: the immutability trigger is extended, not replaced.

ALTER TABLE receipt_draft_registry
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_reason text,
  ADD CONSTRAINT receipt_draft_registry_closed_reason_check
    CHECK (closed_reason IN ('confirmed', 'expired')),
  ADD CONSTRAINT receipt_draft_registry_close_check CHECK (
    (closed_at IS NULL AND closed_reason IS NULL)
    OR (closed_at IS NOT NULL AND closed_reason IS NOT NULL AND closed_at >= created_at)
  );

CREATE OR REPLACE FUNCTION receipt_draft_registry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt draft registry rows are never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_immutable_check';
  END IF;
  IF NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.legacy IS DISTINCT FROM OLD.legacy
     OR NEW.account_user_id IS DISTINCT FROM OLD.account_user_id
     OR NEW.starter_user_id IS DISTINCT FROM OLD.starter_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'who started a draft never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_immutable_check';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a draft''s deletion is recorded once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_deleted_once_check';
  END IF;
  -- 0049: a close is recorded once and never changed or cleared.
  IF OLD.closed_at IS NOT NULL
     AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at
          OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason) THEN
    RAISE EXCEPTION 'a draft''s close is recorded once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_closed_once_check';
  END IF;
  RETURN NEW;
END;
$$;

-- A draft is registered open: a close is only ever recorded on an existing row.
CREATE FUNCTION receipt_draft_registry_open_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a draft is registered open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_closed_once_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipt_draft_registry_open_on_insert
  BEFORE INSERT ON receipt_draft_registry
  FOR EACH ROW EXECUTE FUNCTION receipt_draft_registry_open_on_insert();
