-- MISC-08 (owner decisions 2026-10-31): Admin-managed review eligibility by position, explicit
-- exclusions, and the Lead Project Engineer's separate review approval. Built on the existing
-- reviewer_eligibility grants and review scopes; no competing authorization system.
--
-- Effective eligibility for one person and scope = (an active individual grant OR an active
-- position rule for their current position) AND no active exclusion for that scope or for all
-- scopes. No position is eligible by default: an Admin enables a rule per position and scope.
--
-- Reviewing on a project needs all four: effective eligibility, active team membership that is
-- not pending LPE acceptance (only MISC-07 join requests are ever pending), an active reviewer
-- assignment, and an active LPE review approval of that assignment. An Admin may still assign;
-- the person reviews only once the project's Lead Project Engineer approves.
--
-- An actual loss of effective eligibility ends the person's active approvals in that scope
-- (end_kind 'eligibility_lost') and asks the project's lead to reassign (action request
-- 'review_approval_lost'). Regaining eligibility never reactivates an ended approval: the lead
-- approves again. Blocking unfinished review work and keeping drafts belong to the concrete review
-- cards (C04/C07): no scoped review work exists yet.
--
-- Lock order (project-access): project, accounts, review_eligibility_lock(), grant-review lock,
-- grant, flag, action item.

-- Every eligibility source change and every approval holds this until commit, so a loss and an
-- approval can't interleave.
CREATE FUNCTION review_eligibility_lock() RETURNS void
LANGUAGE sql AS $$
  -- Two-key form, its own key space (grant review uses 25).
  SELECT pg_advisory_xact_lock(26, 0)
$$;

-- An Admin's rule: everyone with `position` is eligible for `scope_code`, now and later.
CREATE TABLE review_position_rule (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position                      text NOT NULL
                                  CHECK (position IN ('technician', 'technologist', 'engineer', 'lab_manager')),
  scope_code                    text NOT NULL REFERENCES review_scope (code),
  granted_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot  text,
  granted_by_name_snapshot      text NOT NULL,
  granted_at                    timestamptz NOT NULL DEFAULT now(),
  grant_reason                  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  grant_idempotency_key         uuid NOT NULL UNIQUE,
  grant_request_hash            text NOT NULL,
  revoked_at                    timestamptz,
  revoked_by_user_id            uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot  text,
  revoked_by_name_snapshot      text,
  revoke_reason                 text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT review_position_rule_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX review_position_rule_active_key
  ON review_position_rule (position, scope_code) WHERE revoked_at IS NULL;
CREATE TRIGGER review_position_rule_history
  BEFORE UPDATE OR DELETE ON review_position_rule
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason');

-- An Admin's exclusion of one person from one scope, or (scope_code NULL) from every scope,
-- including scopes added later. It overrides position rules and individual grants.
CREATE TABLE reviewer_exclusion (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       uuid NOT NULL REFERENCES app_user (id),
  user_initials_snapshot        text,
  user_name_snapshot            text NOT NULL,
  scope_code                    text REFERENCES review_scope (code),
  granted_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot  text,
  granted_by_name_snapshot      text NOT NULL,
  granted_at                    timestamptz NOT NULL DEFAULT now(),
  grant_reason                  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  grant_idempotency_key         uuid NOT NULL UNIQUE,
  grant_request_hash            text NOT NULL,
  revoked_at                    timestamptz,
  revoked_by_user_id            uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot  text,
  revoked_by_name_snapshot      text,
  revoke_reason                 text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT reviewer_exclusion_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX reviewer_exclusion_active_key
  ON reviewer_exclusion (user_id, coalesce(scope_code, '')) WHERE revoked_at IS NULL;
CREATE TRIGGER reviewer_exclusion_history
  BEFORE UPDATE OR DELETE ON reviewer_exclusion
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason');
CREATE TRIGGER reviewer_exclusion_personal
  BEFORE INSERT ON reviewer_exclusion
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('user_id');

-- The one effective-eligibility rule, used by the API for candidates, assignment, approval,
-- authorization and access summaries.
CREATE FUNCTION reviewer_is_eligible(uid uuid, scope text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM reviewer_exclusion x
                     WHERE x.user_id = uid AND x.revoked_at IS NULL
                       AND (x.scope_code IS NULL OR x.scope_code = scope))
     AND (EXISTS (SELECT 1 FROM reviewer_eligibility e
                  WHERE e.user_id = uid AND e.scope_code = scope AND e.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM review_position_rule r
                     JOIN app_user u ON u.position = r.position
                     WHERE u.id = uid AND u.account_type <> 'shared_lab'
                       AND r.scope_code = scope AND r.revoked_at IS NULL))
$$;

-- Active team membership the lead has accepted: members added by the lead or an admin count as
-- accepted; a MISC-07 self-join stays pending until the lead or an admin accepts it.
CREATE FUNCTION project_team_member_accepted(project uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_team_member t
    WHERE t.project_id = project AND t.user_id = uid AND t.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_team_join_request j
                      WHERE j.team_member_id = t.id AND j.status = 'pending'))
$$;

ALTER TABLE project_reviewer_assignment
  ADD CONSTRAINT project_reviewer_assignment_approval_key
  UNIQUE (id, project_id, reviewer_user_id, scope_code);

-- The lead's explicit approval for one reviewer assignment (its project, person and scope).
-- Ending it is permanent; a later approval is a new row.
CREATE TABLE project_review_approval (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  reviewer_assignment_id        uuid NOT NULL,
  reviewer_user_id              uuid NOT NULL REFERENCES app_user (id),
  reviewer_initials_snapshot    text,
  reviewer_name_snapshot        text NOT NULL,
  scope_code                    text NOT NULL REFERENCES review_scope (code),
  approved_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  approved_by_initials_snapshot text,
  approved_by_name_snapshot     text NOT NULL,
  approved_at                   timestamptz NOT NULL DEFAULT now(),
  approve_reason                text CHECK (length(btrim(approve_reason)) BETWEEN 1 AND 2000),
  approve_idempotency_key       uuid NOT NULL UNIQUE,
  approve_request_hash          text NOT NULL,
  ended_at                      timestamptz,
  ended_by_user_id              uuid REFERENCES app_user (id),
  ended_by_initials_snapshot    text,
  ended_by_name_snapshot        text,
  end_reason                    text CHECK (length(btrim(end_reason)) BETWEEN 1 AND 2000),
  -- withdrawn: by the lead; eligibility_lost: an actual loss of effective eligibility;
  -- assignment_ended: the reviewer assignment was removed.
  end_kind                      text CHECK (end_kind IN ('withdrawn', 'eligibility_lost',
                                                         'assignment_ended')),
  FOREIGN KEY (reviewer_assignment_id, project_id, reviewer_user_id, scope_code)
    REFERENCES project_reviewer_assignment (id, project_id, reviewer_user_id, scope_code),
  CONSTRAINT project_review_approval_ended_check CHECK (
    (ended_at IS NULL AND ended_by_user_id IS NULL AND ended_by_name_snapshot IS NULL
     AND ended_by_initials_snapshot IS NULL AND end_reason IS NULL AND end_kind IS NULL)
    OR (ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL
        AND ended_by_name_snapshot IS NOT NULL AND end_reason IS NOT NULL
        AND end_kind IS NOT NULL AND ended_at >= approved_at)
  )
);
CREATE UNIQUE INDEX project_review_approval_active_key
  ON project_review_approval (reviewer_assignment_id) WHERE ended_at IS NULL;
CREATE INDEX project_review_approval_user_idx
  ON project_review_approval (reviewer_user_id) WHERE ended_at IS NULL;
CREATE INDEX project_review_approval_project_idx
  ON project_review_approval (project_id, approved_at);
CREATE TRIGGER project_review_approval_history
  BEFORE UPDATE OR DELETE ON project_review_approval
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'ended_at', 'ended_by_user_id', 'ended_by_initials_snapshot', 'ended_by_name_snapshot',
    'end_reason', 'end_kind');

-- A new approval needs the project's current lead as approver, an active assignment and a
-- reviewer who is effectively eligible now.
CREATE FUNCTION project_review_approval_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project p
                 WHERE p.id = NEW.project_id
                   AND p.lead_project_engineer_user_id = NEW.approved_by_user_id) THEN
    RAISE EXCEPTION 'only the project''s Lead Project Engineer approves a reviewer'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_review_approval_by_lead';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project_reviewer_assignment a
                 WHERE a.id = NEW.reviewer_assignment_id AND a.removed_at IS NULL) THEN
    RAISE EXCEPTION 'the reviewer assignment has ended'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_review_approval_assignment_active';
  END IF;
  IF NOT reviewer_is_eligible(NEW.reviewer_user_id, NEW.scope_code) THEN
    RAISE EXCEPTION 'the reviewer is not eligible for this scope'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_review_approval_eligible';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_review_approval_check
  BEFORE INSERT ON project_review_approval
  FOR EACH ROW EXECUTE FUNCTION project_review_approval_check();

-- Removing an assignment ends its approval with the same who, when and reason.
CREATE FUNCTION project_review_approval_on_assignment_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    UPDATE project_review_approval
    SET ended_at = greatest(NEW.removed_at, approved_at), ended_by_user_id = NEW.removed_by_user_id,
        ended_by_initials_snapshot = NEW.removed_by_initials_snapshot,
        ended_by_name_snapshot = NEW.removed_by_name_snapshot,
        end_reason = NEW.remove_reason, end_kind = 'assignment_ended'
    WHERE reviewer_assignment_id = NEW.id AND ended_at IS NULL;
    -- The lead's "reassign" request for this assignment is settled by its removal.
    UPDATE action_item SET status = 'resolved', resolution = 'reassigned', resolved_at = now(),
           resolved_by_user_id = NEW.removed_by_user_id
    WHERE kind = 'review_approval_lost' AND status = 'open'
      AND entity_id IN (SELECT id FROM project_review_approval
                        WHERE reviewer_assignment_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_reviewer_assignment_review_approval
  AFTER UPDATE ON project_reviewer_assignment
  FOR EACH ROW EXECUTE FUNCTION project_review_approval_on_assignment_end();

-- A fresh approval in the same project and scope settles the lead's "reassign" requests there.
CREATE FUNCTION project_review_approval_on_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE action_item SET status = 'resolved', resolution = 'reassigned', resolved_at = now(),
         resolved_by_user_id = NEW.approved_by_user_id
  WHERE kind = 'review_approval_lost' AND status = 'open' AND project_id = NEW.project_id
    AND entity_id IN (SELECT id FROM project_review_approval
                      WHERE project_id = NEW.project_id AND scope_code = NEW.scope_code);
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_review_approval_settles_requests
  AFTER INSERT ON project_review_approval
  FOR EACH ROW EXECUTE FUNCTION project_review_approval_on_insert();

-- "Review approval lost": one per ended approval, for the project's lead (admins when it has none).
ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_kind_check
  CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request',
                  'lead_appointment', 'grant_review', 'team_join_request',
                  'review_approval_lost'));
ALTER TABLE action_item DROP CONSTRAINT action_item_entity_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_entity_type_check
  CHECK (entity_type IN ('test_request', 'lab_program', 'retention_request', 'project',
                         'team_join_request', 'project_review_approval'));
ALTER TABLE action_item DROP CONSTRAINT action_item_resolution_value_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_resolution_value_check
  CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined',
                        'appointed', 'reviewed', 'accepted', 'reassigned'));
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
    WHEN 'team_join_request' THEN entity_type = 'team_join_request' AND program_id IS NULL
      AND (target_user_id IS NOT NULL OR target_role = 'admin') AND reason IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL
    WHEN 'review_approval_lost' THEN entity_type = 'project_review_approval'
      AND program_id IS NULL AND project_id IS NOT NULL
      AND (target_user_id IS NOT NULL OR target_role = 'admin') AND reason IS NOT NULL
      AND created_by_name_snapshot IS NOT NULL
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION action_item_routes_to_lead_project_engineer(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request', 'retention_request', 'grant_review',
                  'team_join_request', 'review_approval_lost')
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
        WHEN 'team_join_request' THEN p.lead_project_engineer_user_id = uid
          OR EXISTS (SELECT 1 FROM role_assignment r
                     WHERE r.user_id = uid AND r.role = 'admin')
        WHEN 'review_approval_lost' THEN p.lead_project_engineer_user_id = uid
          OR EXISTS (SELECT 1 FROM role_assignment r
                     WHERE r.user_id = uid AND r.role = 'admin')
        ELSE false
      END
  )
$$;

-- Owner decision: each existing reviewer assignment counts as approved by its project's lead,
-- audited as a migration. Only assignments that can work today are recorded: the project has a
-- lead and the reviewer is effectively eligible (an approval for someone ineligible would
-- otherwise come back to life when eligibility returned). Nothing happens on a fresh install.
WITH approved AS (
  INSERT INTO project_review_approval (
    project_id, reviewer_assignment_id, reviewer_user_id, reviewer_initials_snapshot,
    reviewer_name_snapshot, scope_code, approved_by_user_id, approved_by_initials_snapshot,
    approved_by_name_snapshot, approve_reason, approve_idempotency_key, approve_request_hash)
  SELECT a.project_id, a.id, a.reviewer_user_id, a.reviewer_initials_snapshot,
         a.reviewer_name_snapshot, a.scope_code, lead.id, lead.official_initials,
         lead.display_name,
         'Migration 0013: an existing reviewer assignment counts as approved (MISC-08)',
         gen_random_uuid(), 'migration-0013'
  FROM project_reviewer_assignment a
  JOIN project p ON p.id = a.project_id
  JOIN app_user lead ON lead.id = p.lead_project_engineer_user_id
  WHERE a.removed_at IS NULL AND reviewer_is_eligible(a.reviewer_user_id, a.scope_code)
  RETURNING id, project_id, reviewer_assignment_id, reviewer_user_id, scope_code,
            approved_by_user_id
)
INSERT INTO audit_event (action, entity_type, entity_id, actor_account_type, actor_name_snapshot,
                         reason, after_values)
SELECT 'project_review_approval.approved', 'project_review_approval', id, 'system',
       'Migration 0013', 'MISC-08: an existing reviewer assignment counts as approved',
       jsonb_build_object('projectId', project_id, 'reviewerAssignmentId', reviewer_assignment_id,
                          'userId', reviewer_user_id, 'scope', scope_code,
                          'approvedByUserId', approved_by_user_id, 'migration', '0013')
FROM approved;
