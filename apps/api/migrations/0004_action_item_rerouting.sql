-- MM-AO07 (D10, adopted by Kyle 2026-10-29, Option C): open action items follow current
-- eligibility. An item explicitly given to someone who can no longer act on it (they lost the
-- role, were disabled, or stopped being the project's Lead Project Engineer) is no longer theirs:
-- it falls back to its ordinary routing at once. Nothing is rewritten: the assignment and its
-- history stay as recorded, and a Lab Manager or admin can give it to an eligible person again,
-- with a reason. Items nobody can act on now form the unresolved queue (action_item_has_recipient).
-- Routing still grants nothing: every decision rechecks its own permission.

-- Who may act on an item through its workflow (the same people reassignment offers): Lab Managers
-- for a correction; Lab Managers or the project's Lead Project Engineer for a cancellation or
-- retention request; the project's Lead Project Engineer for a closure request; admins for a lead
-- appointment. Active personal (or test) accounts only, never LAB.
CREATE FUNCTION action_item_person_eligible(item_id uuid, uid uuid) RETURNS boolean
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
        ELSE false
      END
  )
$$;

-- Inbox routing: the assignee while they can still act on it; otherwise (never assigned, or the
-- assignment lapsed) a holder of the target role, or the project's current Lead Project Engineer
-- for lead-routed kinds. Account status/type is checked by the caller; LAB never has an inbox.
CREATE OR REPLACE FUNCTION action_item_routed_to(item_id uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN a.assigned_user_id IS NOT NULL AND action_item_person_eligible(a.id, a.assigned_user_id)
      THEN a.assigned_user_id = uid
    ELSE (a.target_role IN ('lab_manager', 'admin')
          AND EXISTS (SELECT 1 FROM role_assignment r
                      WHERE r.user_id = uid AND r.role = a.target_role))
      OR (action_item_routes_to_lead_project_engineer(a.kind) AND p.lead_project_engineer_user_id = uid)
      OR (NOT action_item_routes_to_lead_project_engineer(a.kind) AND a.target_user_id = uid)
  END
  FROM action_item a JOIN project p ON p.id = a.project_id
  WHERE a.id = item_id
$$;

-- True when at least one active personal (or test) account has the item in their inbox. An open
-- item without one is in the unresolved queue that Lab Managers and admins work (D10), e.g. a
-- closure request on a project waiting for a lead (D02), or a correction when nobody is a Lab
-- Manager.
CREATE FUNCTION action_item_has_recipient(item_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.status = 'active' AND u.account_type IN ('personal', 'test')
      AND action_item_routed_to(item_id, u.id)
  )
$$;
