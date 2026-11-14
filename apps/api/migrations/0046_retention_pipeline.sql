-- STRATA-90/91 (Strata lane C): the Retention pipeline and its decision drawer.
--
-- 1. A hold may name the date it is meant to last until (hold_until). The date is shown ("On hold
--    until 2027-03-31") and never releases the hold by itself: a hold stays in force until
--    someone with authority releases it, with a reason (MM-T29). NULL = until released.
--    A hold request carries the same optional date.
-- 2. The disposal list (disposal_list_entry): the step between Eligible and Approved. The
--    project's Lead Project Engineer or a Lab Manager puts an eligible unit on the list; they
--    approve it (disposal_approval, MM-T30) or take it off again with a reason. Revoking an
--    approval puts the unit back on the list. Being on the list never disposes anything and never
--    changes the unit's status.
--    * at most one live entry per unit;
--    * an entry ends once: removed (with a reason, who and when), approved (the approval it
--      became) or closed (the unit left stock another way, e.g. removal after testing);
--    * entries are history: never deleted, never changed after they end.

ALTER TABLE retention_hold ADD COLUMN hold_until date;
ALTER TABLE retention_request ADD COLUMN hold_until date;
ALTER TABLE retention_request ADD CONSTRAINT retention_request_hold_until
  CHECK (kind = 'hold' OR hold_until IS NULL);

CREATE TABLE disposal_list_entry (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  added_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  added_by_initials_snapshot  text,
  added_by_name_snapshot      text NOT NULL,
  added_at                    timestamptz NOT NULL DEFAULT now(),
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  -- Set when a revoked approval put the unit back on the list.
  from_approval_id            uuid REFERENCES disposal_approval (id),
  idempotency_key             uuid NOT NULL,
  request_hash                text NOT NULL,
  ended_at                    timestamptz,
  end_kind                    text CHECK (end_kind IN ('removed', 'approved', 'closed')),
  ended_by_user_id            uuid REFERENCES app_user (id),
  ended_by_name_snapshot      text,
  end_reason                  text CHECK (length(btrim(end_reason)) BETWEEN 1 AND 2000),
  approval_id                 uuid REFERENCES disposal_approval (id),
  end_idempotency_key         uuid,
  CONSTRAINT disposal_list_entry_batch_unit UNIQUE (idempotency_key, storage_unit_id),
  CONSTRAINT disposal_list_entry_end_shape CHECK (
    (ended_at IS NULL AND end_kind IS NULL AND ended_by_user_id IS NULL
     AND ended_by_name_snapshot IS NULL AND end_reason IS NULL AND approval_id IS NULL
     AND end_idempotency_key IS NULL)
    OR (end_kind = 'removed' AND ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL
        AND ended_by_name_snapshot IS NOT NULL AND end_reason IS NOT NULL
        AND approval_id IS NULL AND end_idempotency_key IS NOT NULL)
    OR (end_kind = 'approved' AND ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL
        AND ended_by_name_snapshot IS NOT NULL AND approval_id IS NOT NULL
        AND end_reason IS NULL)
    OR (end_kind = 'closed' AND ended_at IS NOT NULL AND approval_id IS NULL)
  )
);
-- At most one live entry per unit.
CREATE UNIQUE INDEX disposal_list_entry_live_key ON disposal_list_entry (storage_unit_id)
  WHERE ended_at IS NULL;
CREATE INDEX disposal_list_entry_project_idx ON disposal_list_entry (project_id)
  WHERE ended_at IS NULL;

-- Ends once; nothing else changes; never deleted.
CREATE FUNCTION disposal_list_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disposal list history can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['ended_at', 'end_kind', 'ended_by_user_id', 'ended_by_name_snapshot',
                               'end_reason', 'approval_id', 'end_idempotency_key'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['ended_at', 'end_kind', 'ended_by_user_id', 'ended_by_name_snapshot',
                               'end_reason', 'approval_id', 'end_idempotency_key']) THEN
    RAISE EXCEPTION 'disposal list entry % can only end once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_list_entry_guard
  BEFORE UPDATE OR DELETE ON disposal_list_entry
  FOR EACH ROW EXECUTE FUNCTION disposal_list_entry_guard();

-- Only a unit in stock (in its current project) goes on the list, and an approval it became is
-- for the same unit.
CREATE FUNCTION disposal_list_entry_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM storage_unit su
                   WHERE su.id = NEW.storage_unit_id AND su.status = 'in_stock'
                     AND su.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'only a unit in stock goes on the disposal list'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_list_entry_in_stock';
    END IF;
  ELSIF NEW.approval_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM disposal_approval a
          WHERE a.id = NEW.approval_id AND a.storage_unit_id = NEW.storage_unit_id) THEN
    RAISE EXCEPTION 'the approval is for another unit'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_list_entry_approval_unit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_list_entry_check
  BEFORE INSERT OR UPDATE ON disposal_list_entry
  FOR EACH ROW EXECUTE FUNCTION disposal_list_entry_check();
