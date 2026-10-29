-- MM-AO04: project creation, lead nomination and confirmation, unassigned projects (owner
-- decisions D01, D02, D08, D10 of 2026-10-29, with Kyle's AO04 answers of the same day: admin
-- intake through an inbox item plus a list filter; the creator, then any staff, may nominate;
-- admins appoint directly and may remove a lead; closure requests on a project with no lead wait
-- for the next lead).

-- D02: a project may be saved and receive samples with no Lead Project Engineer. Only decisions
-- that need the lead are blocked; there is no creator or admin fallback. The column stays the one
-- effective lead (D03): a pending nomination (project_lead_nomination) never fills it.
ALTER TABLE project ALTER COLUMN lead_project_engineer_user_id DROP NOT NULL;

-- Admin intake (D02): one open "Lead appointment" action request per project that has no
-- effective lead, routed to every admin. It is resolved ("appointed") in the transaction that
-- confirms or appoints a lead; removing a lead opens a new one.
ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_kind_check
  CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request',
                  'lead_appointment'));
ALTER TABLE action_item DROP CONSTRAINT action_item_target_role_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_target_role_check
  CHECK (target_role IN ('lab_manager', 'admin'));
ALTER TABLE action_item DROP CONSTRAINT action_item_entity_type_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_entity_type_check
  CHECK (entity_type IN ('test_request', 'lab_program', 'retention_request', 'project'));
-- A closure request on a project with no lead has no recipient yet: it reaches the lead's inbox
-- as soon as one is appointed, because lead-routed items follow the project's current lead.
ALTER TABLE action_item DROP CONSTRAINT action_item_target_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_target_check
  CHECK (target_role IS NOT NULL OR target_user_id IS NOT NULL OR kind = 'closure_request');
ALTER TABLE action_item DROP CONSTRAINT action_item_resolution_value_check;
ALTER TABLE action_item ADD CONSTRAINT action_item_resolution_value_check
  CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined',
                        'appointed'));
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
    ELSE false
  END
);

-- Inbox routing: admins hold the admin-targeted items, as Lab Managers hold theirs.
CREATE OR REPLACE FUNCTION action_item_routed_to(item_id uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN a.assigned_user_id IS NOT NULL THEN a.assigned_user_id = uid
    ELSE (a.target_role IN ('lab_manager', 'admin')
          AND EXISTS (SELECT 1 FROM role_assignment r
                      WHERE r.user_id = uid AND r.role = a.target_role))
      OR (action_item_routes_to_lead_project_engineer(a.kind) AND p.lead_project_engineer_user_id = uid)
      OR (NOT action_item_routes_to_lead_project_engineer(a.kind) AND a.target_user_id = uid)
  END
  FROM action_item a JOIN project p ON p.id = a.project_id
  WHERE a.id = item_id
$$;

-- Admins find projects waiting for a lead quickly.
CREATE INDEX project_waiting_for_lead_idx ON project (created_at)
  WHERE lead_project_engineer_user_id IS NULL;
