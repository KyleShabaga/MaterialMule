-- MISC-06 (owner decision 2026-10-31): staff positions are Technician, Technologist, Engineer and
-- Lab Manager, plus NULL for "Not set" (not a fifth position). An Admin sets them in Settings →
-- Staff & access; there is no first-sign-in choice any more. A position grants nothing.
--
-- Project Engineer folds into Engineer: a category rename, not a loss and regain of anything.
-- Only app_user.position changes. User IDs, identities, initials, position_set_at, roles,
-- project roles (including the project role 'project_engineer', which is unrelated), assignments,
-- reviewer eligibility and grants are untouched, and no Technician becomes a Technologist.
-- Historical audit values ('project_engineer' in earlier before/after values) stay as written;
-- each converted person gets one system audit event, and one summary event records the mapping
-- and the count (none on a fresh install, where nobody is converted).
--
-- position_set_at is kept (it now means "when the position was last set"), and so is the CHECK
-- app_user_position_set_has_position: a timestamp still needs a position.

ALTER TABLE app_user DROP CONSTRAINT app_user_position_check;

WITH converted AS (
  UPDATE app_user SET position = 'engineer'
  WHERE position = 'project_engineer'
  RETURNING id
),
per_person AS (
  INSERT INTO audit_event (action, entity_type, entity_id, actor_account_type,
                           actor_name_snapshot, reason, before_values, after_values)
  SELECT 'user.position_consolidated', 'app_user', id, 'system', 'Migration 0012',
         'MISC-06: the Project Engineer position is now Engineer',
         jsonb_build_object('position', 'project_engineer'),
         jsonb_build_object('position', 'engineer')
  FROM converted
  RETURNING 1
)
INSERT INTO audit_event (action, entity_type, actor_account_type, actor_name_snapshot, reason,
                         after_values)
SELECT 'migration.positions_consolidated', 'migration', 'system', 'Migration 0012',
       'MISC-06: consolidate staff positions',
       jsonb_build_object('migration', '0012_staff_positions',
                          'mapping', jsonb_build_object('project_engineer', 'engineer'),
                          'affected', (SELECT count(*) FROM per_person))
WHERE EXISTS (SELECT 1 FROM per_person);

ALTER TABLE app_user ADD CONSTRAINT app_user_position_check
  CHECK (position IN ('technician', 'technologist', 'engineer', 'lab_manager'));
