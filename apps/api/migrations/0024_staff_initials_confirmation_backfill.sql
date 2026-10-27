-- MM-T44: official initials assigned by an admin are confirmed by that admin.
--
-- Before this fix, POST /api/staff (staff.preprovisioned) and PATCH /api/staff/:id
-- (staff.initials_changed) wrote official_initials without initials_confirmed_by_user_id /
-- initials_confirmed_at, so My profile showed "Not confirmed yet". The API now writes the pair in
-- the same transaction. This recovers it for rows the old code left behind, using only the audit
-- trail as evidence: the latest event that set the person's initials must be one of those two
-- admin actions, by a named person, and must have set exactly the value still on record. Its
-- actor and time become the confirmation. Anything else (seeded rows, unaudited values, initials
-- changed again since) stays unconfirmed for an admin to confirm explicitly in Staff & access.

WITH latest_assignment AS (
  SELECT DISTINCT ON (e.entity_id)
         e.entity_id, e.action, e.actor_user_id, e.actor_account_type, e.occurred_at,
         e.after_values ->> 'officialInitials' AS official_initials
  FROM audit_event e
  WHERE e.entity_type = 'app_user'
    AND e.action IN ('staff.preprovisioned', 'staff.initials_changed')
  ORDER BY e.entity_id, e.occurred_at DESC, e.id DESC
)
UPDATE app_user u
SET initials_confirmed_by_user_id = a.actor_user_id,
    initials_confirmed_at = a.occurred_at
FROM latest_assignment a
WHERE a.entity_id = u.id
  AND u.initials_confirmed_at IS NULL
  AND u.official_initials IS NOT NULL
  AND a.official_initials = u.official_initials
  AND a.actor_user_id IS NOT NULL
  AND a.actor_account_type IN ('personal', 'test');
