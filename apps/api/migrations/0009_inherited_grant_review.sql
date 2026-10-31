-- MTR-25 (owner decision, Kyle 2026-10-30): when a project gets a new Lead Project Engineer, the
-- acceptance-delegate, report-issuer and reviewer grants it already has survive (D08) but are
-- flagged "Needs review by new lead". The lead or an admin keeps or revokes each one, with a
-- reason. One "Review inherited grants" action request per project goes to the lead and is
-- resolved once no flag is left pending. The API raises the flags in the lead-change transaction;
-- these rules keep them consistent for every writer.

CREATE TABLE project_grant_review (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  -- Exactly one of the three grants, each on the same project (checked by the trigger below).
  acceptance_delegation_id      uuid REFERENCES acceptance_delegation (id),
  report_issuer_grant_id        uuid REFERENCES project_report_issuer_grant (id),
  reviewer_assignment_id        uuid REFERENCES project_reviewer_assignment (id),
  -- The lead whose appointment raised the flag.
  flagged_for_user_id           uuid NOT NULL REFERENCES app_user (id),
  flagged_at                    timestamptz NOT NULL DEFAULT now(),
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'kept', 'revoked')),
  decided_at                    timestamptz,
  decided_by_user_id            uuid REFERENCES app_user (id),
  decided_by_initials_snapshot  text,
  decided_by_name_snapshot      text,
  decision_reason               text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT project_grant_review_one_grant CHECK (
    num_nonnulls(acceptance_delegation_id, report_issuer_grant_id, reviewer_assignment_id) = 1
  ),
  CONSTRAINT project_grant_review_decision_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL
     AND decided_by_initials_snapshot IS NULL AND decided_by_name_snapshot IS NULL
     AND decision_reason IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND decided_by_name_snapshot IS NOT NULL AND decision_reason IS NOT NULL
        AND decided_at >= flagged_at)
  )
);
-- One pending flag per grant: a second lead change before the review moves nothing.
CREATE UNIQUE INDEX project_grant_review_delegation_pending_key
  ON project_grant_review (acceptance_delegation_id)
  WHERE status = 'pending' AND acceptance_delegation_id IS NOT NULL;
CREATE UNIQUE INDEX project_grant_review_issuer_pending_key
  ON project_grant_review (report_issuer_grant_id)
  WHERE status = 'pending' AND report_issuer_grant_id IS NOT NULL;
CREATE UNIQUE INDEX project_grant_review_reviewer_pending_key
  ON project_grant_review (reviewer_assignment_id)
  WHERE status = 'pending' AND reviewer_assignment_id IS NOT NULL;
CREATE INDEX project_grant_review_project_idx ON project_grant_review (project_id, flagged_at);

-- Decided once; nothing else ever changes, and no row is deleted.
CREATE TRIGGER project_grant_review_history
  BEFORE UPDATE OR DELETE ON project_grant_review
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'decided_at', 'status', 'decided_by_user_id', 'decided_by_initials_snapshot',
    'decided_by_name_snapshot', 'decision_reason');

-- A flag names a grant of its own project that is still active when flagged.
CREATE FUNCTION project_grant_review_grant_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM acceptance_delegation g
    WHERE g.id = NEW.acceptance_delegation_id AND g.project_id = NEW.project_id
      AND g.revoked_at IS NULL
    UNION ALL
    SELECT 1 FROM project_report_issuer_grant g
    WHERE g.id = NEW.report_issuer_grant_id AND g.project_id = NEW.project_id
      AND g.revoked_at IS NULL
    UNION ALL
    SELECT 1 FROM project_reviewer_assignment g
    WHERE g.id = NEW.reviewer_assignment_id AND g.project_id = NEW.project_id
      AND g.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a grant review flag needs an active grant of the same project'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_grant_review_grant_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_grant_review_grant_check
  BEFORE INSERT ON project_grant_review
  FOR EACH ROW EXECUTE FUNCTION project_grant_review_grant_check();

-- One project's flags change one transaction at a time: deciding, ending a flagged grant by any
-- route, and raising flags all hold this transaction-scoped lock until commit. Without it, two
-- transactions deciding a project's last two flags each see the other's flag still pending, both
-- leave the request open, and it stays open with nothing to review. The API takes it right after
-- the project row and the accounts, before any grant, flag or action item row (lock order:
-- project, accounts, this lock in project-id order, grant, flag, action item); settling takes it
-- again (re-entrant) so a writer outside the API is still serialised.
CREATE FUNCTION project_grant_review_lock(project uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Two-key form: its key space never overlaps the migrator's single-key advisory lock.
  PERFORM pg_advisory_xact_lock(25, hashtext(project::text));
END;
$$;

-- The project's "Review inherited grants" request is resolved once no flag is pending. PL/pgSQL
-- runs each statement in a fresh snapshot, so the check below sees every flag a writer that held
-- the lock before us committed.
CREATE FUNCTION project_grant_review_settle(project uuid, by_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM project_grant_review_lock(project);
  UPDATE action_item SET status = 'resolved', resolution = 'reviewed', resolved_at = now(),
         resolved_by_user_id = by_user
  WHERE kind = 'grant_review' AND entity_id = project AND status = 'open'
    AND NOT EXISTS (SELECT 1 FROM project_grant_review r
                    WHERE r.project_id = project AND r.status = 'pending');
END;
$$;

-- However a flagged grant ends (Revoke here, the grant's own remove/revoke, or D08 revalidation),
-- its pending flag is settled as revoked with that ending's who, when and reason.
CREATE FUNCTION project_grant_review_on_grant_end() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ended jsonb := to_jsonb(NEW);
  prefix text := TG_ARGV[0];
  column_name text := TG_ARGV[1];
  ended_at timestamptz := (ended ->> (prefix || '_at'))::timestamptz;
  ended_by uuid := (ended ->> (prefix || '_by_user_id'))::uuid;
BEGIN
  IF (to_jsonb(OLD) ->> (prefix || '_at')) IS NULL AND ended_at IS NOT NULL THEN
    UPDATE project_grant_review
    SET status = 'revoked', decided_at = greatest(ended_at, flagged_at),
        decided_by_user_id = ended_by,
        decided_by_initials_snapshot = ended ->> (prefix || '_by_initials_snapshot'),
        decided_by_name_snapshot = ended ->> (prefix || '_by_name_snapshot'),
        decision_reason = ended ->> TG_ARGV[2]
    WHERE status = 'pending' AND (to_jsonb(project_grant_review) ->> column_name)::uuid = NEW.id;
    IF FOUND THEN
      PERFORM project_grant_review_settle(NEW.project_id, ended_by);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER acceptance_delegation_grant_review
  AFTER UPDATE ON acceptance_delegation
  FOR EACH ROW EXECUTE FUNCTION project_grant_review_on_grant_end(
    'revoked', 'acceptance_delegation_id', 'revoke_reason');
CREATE TRIGGER project_report_issuer_grant_grant_review
  AFTER UPDATE ON project_report_issuer_grant
  FOR EACH ROW EXECUTE FUNCTION project_grant_review_on_grant_end(
    'revoked', 'report_issuer_grant_id', 'revoke_reason');
CREATE TRIGGER project_reviewer_assignment_grant_review
  AFTER UPDATE ON project_reviewer_assignment
  FOR EACH ROW EXECUTE FUNCTION project_grant_review_on_grant_end(
    'removed', 'reviewer_assignment_id', 'remove_reason');

-- The "Review inherited grants" action request: one open per project, for its current lead.
ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_kind_check
  CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request',
                  'lead_appointment', 'grant_review'));
ALTER TABLE action_item DROP CONSTRAINT action_item_resolution_value_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_resolution_value_check
  CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined',
                        'appointed', 'reviewed'));
ALTER TABLE action_item DROP CONSTRAINT action_item_shape_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_shape_check CHECK (
  CASE kind
    WHEN 'correction' THEN entity_type = 'test_request' AND opened_by_event_id IS NOT NULL
      AND program_id IS NOT NULL
    WHEN 'cancellation_request' THEN entity_type = 'test_request' AND reason IS NOT NULL
      AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL AND program_id IS NOT NULL
    WHEN 'closure_request' THEN entity_type = 'lab_program' AND program_id IS NOT NULL
      AND entity_id = program_id AND reason IS NOT NULL AND idempotency_key IS NOT NULL
      AND request_hash IS NOT NULL AND created_by_name_snapshot IS NOT NULL
    WHEN 'retention_request' THEN entity_type = 'retention_request' AND program_id IS NULL
      AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL
    WHEN 'lead_appointment' THEN entity_type = 'project' AND entity_id = project_id
      AND program_id IS NULL AND target_role = 'admin' AND reason IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL
    WHEN 'grant_review' THEN entity_type = 'project' AND entity_id = project_id
      AND program_id IS NULL AND target_user_id IS NOT NULL AND reason IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL
    ELSE false
  END
);

-- It follows the project's current lead, like a closure request.
CREATE OR REPLACE FUNCTION action_item_routes_to_lead_project_engineer(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request', 'retention_request', 'grant_review')
$$;

CREATE OR REPLACE FUNCTION action_item_person_eligible(item_id uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM action_item a
    JOIN project p ON p.id = a.project_id
    JOIN app_user u ON u.id = uid
    WHERE a.id = item_id
      AND u.status = 'active' AND u.account_type IN ('personal', 'test')
      AND CASE a.kind
        WHEN 'correction' THEN EXISTS (SELECT 1 FROM role_assignment r
                                       WHERE r.user_id = uid AND r.role = 'lab_manager')
        WHEN 'cancellation_request' THEN p.lead_project_engineer_user_id = uid
          OR EXISTS (SELECT 1 FROM role_assignment r
                     WHERE r.user_id = uid AND r.role = 'lab_manager')
        WHEN 'retention_request' THEN p.lead_project_engineer_user_id = uid
          OR EXISTS (SELECT 1 FROM role_assignment r
                     WHERE r.user_id = uid AND r.role = 'lab_manager')
        WHEN 'closure_request' THEN p.lead_project_engineer_user_id = uid
        WHEN 'lead_appointment' THEN EXISTS (SELECT 1 FROM role_assignment r
                                             WHERE r.user_id = uid AND r.role = 'admin')
        WHEN 'grant_review' THEN p.lead_project_engineer_user_id = uid
        ELSE false
      END
  )
$$;
