-- MISC-07 (owner decision, Kyle 2026-10-30): any signed-in personal account may ask to join a
-- project's team. The request adds them to the team at once (full team-member access, which
-- grants no review, acceptance, issuance or other controlled authority: D04), marked "Pending LPE
-- acceptance". The project's Lead Project Engineer is told through an action request (admins when
-- the project has no lead yet); the lead or an admin accepts, or declines with a reason, which
-- removes them from the team. They may then ask again. Consequence, accepted by the owner: anyone
-- can give themselves team access to any project until the lead or an admin declines.

CREATE TABLE project_team_join_request (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  user_id                       uuid NOT NULL REFERENCES app_user (id),
  -- The team membership the request created; one request per membership.
  team_member_id                uuid NOT NULL UNIQUE REFERENCES project_team_member (id),
  requested_at                  timestamptz NOT NULL DEFAULT now(),
  request_idempotency_key       uuid NOT NULL UNIQUE,
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'accepted', 'declined')),
  decided_at                    timestamptz,
  decided_by_user_id            uuid REFERENCES app_user (id),
  decided_by_initials_snapshot  text,
  decided_by_name_snapshot      text,
  decision_reason               text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT project_team_join_request_decision_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL
     AND decided_by_initials_snapshot IS NULL AND decided_by_name_snapshot IS NULL
     AND decision_reason IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND decided_by_name_snapshot IS NOT NULL AND decided_at >= requested_at
        -- Declining needs a reason; accepting doesn't.
        AND (status = 'accepted' OR decision_reason IS NOT NULL))
  )
);
-- Repeat requests never stack: one pending request per person and project (and the team's own
-- project_team_member_active_key keeps one active membership).
CREATE UNIQUE INDEX project_team_join_request_pending_key
  ON project_team_join_request (project_id, user_id) WHERE status = 'pending';
CREATE INDEX project_team_join_request_project_idx
  ON project_team_join_request (project_id, requested_at);

CREATE TRIGGER project_team_join_request_history
  BEFORE UPDATE OR DELETE ON project_team_join_request
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'decided_at', 'status', 'decided_by_user_id', 'decided_by_initials_snapshot',
    'decided_by_name_snapshot', 'decision_reason');
CREATE TRIGGER project_team_join_request_personal
  BEFORE INSERT ON project_team_join_request
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('user_id');

-- The membership belongs to the same person and project, is active, and was added by that person.
CREATE FUNCTION project_team_join_request_member_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM project_team_member t
    WHERE t.id = NEW.team_member_id AND t.project_id = NEW.project_id
      AND t.user_id = NEW.user_id AND t.added_by_user_id = NEW.user_id AND t.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a join request needs the requester''s own active membership of that project'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_team_join_request_member_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_team_join_request_member_check
  BEFORE INSERT ON project_team_join_request
  FOR EACH ROW EXECUTE FUNCTION project_team_join_request_member_check();

-- However a pending member leaves the team (Decline, or an ordinary removal), the request is
-- declined with that removal's who, when and reason, and its action request is resolved.
CREATE FUNCTION project_team_join_request_on_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_id uuid;
BEGIN
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    UPDATE project_team_join_request
    SET status = 'declined', decided_at = greatest(NEW.removed_at, requested_at),
        decided_by_user_id = NEW.removed_by_user_id,
        decided_by_initials_snapshot = NEW.removed_by_initials_snapshot,
        decided_by_name_snapshot = NEW.removed_by_name_snapshot,
        decision_reason = NEW.remove_reason
    WHERE team_member_id = NEW.id AND status = 'pending'
    RETURNING id INTO request_id;
    IF request_id IS NOT NULL THEN
      UPDATE action_item SET status = 'resolved', resolution = 'declined', resolved_at = now(),
             resolved_by_user_id = NEW.removed_by_user_id
      WHERE kind = 'team_join_request' AND entity_id = request_id AND status = 'open';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_team_member_join_request
  AFTER UPDATE ON project_team_member
  FOR EACH ROW EXECUTE FUNCTION project_team_join_request_on_removal();

-- The "Team join request" action request: one per request, for the project's lead (admins when
-- the project has no lead when it is made). Accepting resolves it as accepted.
ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_kind_check
  CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request',
                  'lead_appointment', 'grant_review', 'team_join_request'));
ALTER TABLE action_item DROP CONSTRAINT action_item_entity_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_entity_type_check
  CHECK (entity_type IN ('test_request', 'lab_program', 'retention_request', 'project',
                         'team_join_request'));
ALTER TABLE action_item DROP CONSTRAINT action_item_resolution_value_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_resolution_value_check
  CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined',
                        'appointed', 'reviewed', 'accepted'));
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
    ELSE false
  END
);

CREATE OR REPLACE FUNCTION action_item_routes_to_lead_project_engineer(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request', 'retention_request', 'grant_review',
                  'team_join_request')
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
        ELSE false
      END
  )
$$;
