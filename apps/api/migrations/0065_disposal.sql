-- MM-T30: whole-unit disposal approval and online removal (standard route).
--
-- Standard eligibility (unit_disposal_eligible): the unit is in stock, its effective retain-until
-- (MM-T29 unit_retention) has been reached, no active hold covers it, and no lab program that
-- covers it is still open. Covering uses the existing rules: a not-closed program that froze the
-- unit into coverage, chose it on a draft line, names it as a standalone source, linked it as
-- tested (MM-T23/T24, as for corrections, D47), or has a line on a test hole the unit belongs to
-- (a summary for the hole, a tube sourced from it, or a bucket of a bulk group sourced from it),
-- so a later receipt on an open program's hole is covered too.
--
-- Approval (PM/PE of the project or Lab Manager) sets status approved_for_disposal and records
-- who and when; it never disposes. Revoking (same people, reason) returns the unit to in_stock.
-- Removal is a separate, online-only scan by a personal account: it locks the unit, requires an
-- active approval and rechecks eligibility (holds placed after approval block it), then records
-- the disposition, actor, time and last location atomically. The location row stays as history;
-- a disposed unit no longer occupies it or counts as current stock.
--
-- MM-T36's post-testing route (tested_unit_removal) stays separate and needs none of this.
-- Once disposed by either route, a unit never returns to stock.

ALTER TABLE storage_unit
  ADD COLUMN disposed_at           timestamptz,
  ADD COLUMN disposed_by_user_id   uuid REFERENCES app_user (id);

UPDATE storage_unit su SET disposed_at = t.removed_at, disposed_by_user_id = t.removed_by_user_id
FROM tested_unit_removal t WHERE t.storage_unit_id = su.id;

-- A disposed unit stays disposed, whichever route disposed it.
CREATE FUNCTION storage_unit_disposed_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A unit removed after testing is guarded by storage_unit_tested_removal_final (MM-T36).
  IF OLD.status = 'disposed' AND NEW.status IS DISTINCT FROM 'disposed'
     AND NOT EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = OLD.id) THEN
    RAISE EXCEPTION 'storage unit % is disposed', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_final
  BEFORE UPDATE OF status ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_is_final();

-- ---------------------------------------------------------------------------------------------
-- Covering programs and standard eligibility
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION unit_open_covering_programs(unit_id uuid)
RETURNS TABLE (program_id uuid, program_number text)
LANGUAGE sql STABLE AS $$
  SELECT lp.id, lp.program_number
  FROM lab_program lp
  JOIN storage_unit su ON su.id = unit_id AND su.project_id = lp.project_id
  WHERE lp.status <> 'closed'
    AND (EXISTS (SELECT 1 FROM program_scope_snapshot s
                 WHERE s.program_id = lp.id AND s.storage_unit_id = su.id AND s.included)
         OR EXISTS (SELECT 1 FROM test_line_unit_choice c JOIN test_line l ON l.id = c.line_id
                    WHERE l.program_id = lp.id AND c.storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_bulk_group_id = su.bulk_group_id)
         OR EXISTS (SELECT 1 FROM test_request_unit_link t JOIN test_request r ON r.id = t.test_request_id
                    WHERE r.program_id = lp.id AND t.storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_kind = 'test_hole'
                      AND (EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                                   WHERE h.storage_unit_id = su.id AND h.test_hole_id = l.test_hole_id)
                           OR su.source_test_hole_id = l.test_hole_id
                           OR EXISTS (SELECT 1 FROM bulk_group g
                                      WHERE g.id = su.bulk_group_id
                                        AND g.test_hole_id = l.test_hole_id))))
$$;

-- Standard disposal eligibility as of `as_of` (today in the business time zone). `allow_approved`
-- lets removal recheck a unit that is already approved.
CREATE FUNCTION unit_disposal_eligible(unit_id uuid, as_of date, allow_approved boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (su.status = 'in_stock' OR (allow_approved AND su.status = 'approved_for_disposal'))
         AND ur.effective_retain_until <= as_of
         AND ur.active_hold_count = 0
         AND NOT EXISTS (SELECT 1 FROM unit_open_covering_programs(su.id))
         -- Where the unit actually is must be settled first (MM-T28, D29).
         AND NOT EXISTS (SELECT 1 FROM location_conflict c
                         WHERE c.storage_unit_id = su.id AND c.status = 'open')
  FROM storage_unit su JOIN unit_retention ur ON ur.storage_unit_id = su.id
  WHERE su.id = unit_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Approval
-- ---------------------------------------------------------------------------------------------

CREATE TABLE disposal_approval (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  -- Units approved together share a batch.
  batch_id                    uuid NOT NULL,
  approved_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  approved_by_initials_snapshot text,
  approved_by_name_snapshot   text NOT NULL,
  approved_at                 timestamptz NOT NULL DEFAULT now(),
  -- Retain-until it was approved against (history).
  effective_retain_until      date NOT NULL,
  revoked_at                  timestamptz,
  revoked_by_user_id          uuid REFERENCES app_user (id),
  revoked_by_name_snapshot    text,
  revoke_reason               text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  -- Set when the unit is removed under this approval.
  used_at                     timestamptz,
  idempotency_key             uuid NOT NULL,
  request_hash                text NOT NULL,
  revoke_idempotency_key      uuid UNIQUE,
  CONSTRAINT disposal_approval_batch_unit UNIQUE (idempotency_key, storage_unit_id),
  CONSTRAINT disposal_approval_state CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL
     AND revoke_idempotency_key IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoke_idempotency_key IS NOT NULL AND used_at IS NULL)
  )
);
-- At most one live (not revoked) approval per unit.
CREATE UNIQUE INDEX disposal_approval_live_key ON disposal_approval (storage_unit_id)
  WHERE revoked_at IS NULL;
CREATE INDEX disposal_approval_project_idx ON disposal_approval (project_id, approved_at);

-- Revoked or used once; nothing else changes; never deleted.
CREATE FUNCTION disposal_approval_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disposal approvals can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR OLD.used_at IS NOT NULL
     OR (NEW.revoked_at IS NULL AND NEW.used_at IS NULL)
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by_user_id', 'revoked_by_name_snapshot',
                               'revoke_reason', 'used_at', 'revoke_idempotency_key'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by_user_id', 'revoked_by_name_snapshot',
                               'revoke_reason', 'used_at', 'revoke_idempotency_key']) THEN
    RAISE EXCEPTION 'disposal approval % can only be revoked or used once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_approval_guard
  BEFORE UPDATE OR DELETE ON disposal_approval
  FOR EACH ROW EXECUTE FUNCTION disposal_approval_guard();

-- ---------------------------------------------------------------------------------------------
-- Standard removal
-- ---------------------------------------------------------------------------------------------

CREATE TABLE disposal_removal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One disposition per physical unit, ever.
  storage_unit_id             uuid NOT NULL UNIQUE REFERENCES storage_unit (id),
  approval_id                 uuid NOT NULL UNIQUE REFERENCES disposal_approval (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot   text NOT NULL,
  location_id                 uuid NOT NULL REFERENCES location (id),
  location_code_snapshot      text NOT NULL,
  location_name_snapshot      text NOT NULL,
  removed_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  removed_by_account_type     text NOT NULL CHECK (removed_by_account_type IN ('personal', 'test')),
  removed_by_initials_snapshot text,
  removed_by_name_snapshot    text NOT NULL,
  removed_at                  timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL
);
CREATE INDEX disposal_removal_project_idx ON disposal_removal (project_id, removed_at);

CREATE TRIGGER disposal_removal_append_only
  BEFORE UPDATE OR DELETE ON disposal_removal
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Written after the unit update in the removal transaction: the unit is disposed, at the
-- recorded location, under that approval (used now), and has no post-testing removal.
CREATE FUNCTION disposal_removal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit.status <> 'disposed' OR unit.project_id <> NEW.project_id
     OR unit.current_location_id <> NEW.location_id
     OR NOT EXISTS (SELECT 1 FROM disposal_approval a
                    WHERE a.id = NEW.approval_id AND a.storage_unit_id = NEW.storage_unit_id
                      AND a.revoked_at IS NULL AND a.used_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = NEW.storage_unit_id) THEN
    RAISE EXCEPTION 'disposal of % doesn''t match the unit and its approval', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_removal_matches_unit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_removal_guard
  BEFORE INSERT ON disposal_removal
  FOR EACH ROW EXECUTE FUNCTION disposal_removal_guard();
