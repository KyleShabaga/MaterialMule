-- Fictional development/test fixtures. Never run in production (the CLI refuses).
-- Fixed UUIDs keep audit references stable: re-running this file (npm run db:reset:dev) restores
-- fixture profile fields and roles but never changes an ID or touches audit history.
-- Sign-in keys must match apps/api/src/auth/test-provider/fixtures.ts (TRP-T33).

INSERT INTO app_user (id, display_name, given_name, surname, official_initials, position, account_type, status)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'Pat Example',  'Pat',    'Example', 'PE',  'pm_pe',       'test', 'active'),
  ('00000000-0000-4000-8000-000000000102', 'Alex Tester',  'Alex',   'Tester',  'AT',  'technician',  'test', 'active'),
  ('00000000-0000-4000-8000-000000000103', 'Admin (test)', 'Admin',  'Test',    'ADM', NULL,          'test', 'active'),
  ('00000000-0000-4000-8000-000000000104', 'Lab (test)',   'Lab',    'Test',    'LAB', 'lab_manager', 'test', 'active'),
  ('00000000-0000-4000-8000-000000000105', 'Dana Example', 'Dana',   'Example', 'DE',  'engineer',    'test', 'active'),
  -- Two staff sharing the initials JS, to exercise duplicate-initial handling (TRP-T07).
  ('00000000-0000-4000-8000-000000000106', 'Jordan Smith', 'Jordan', 'Smith',   'JS',  'technician',  'test', 'active'),
  ('00000000-0000-4000-8000-000000000107', 'Jamie Song',   'Jamie',  'Song',    'JS',  'engineer',    'test', 'active')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  given_name = EXCLUDED.given_name,
  surname = EXCLUDED.surname,
  official_initials = EXCLUDED.official_initials,
  position = EXCLUDED.position,
  account_type = EXCLUDED.account_type,
  status = EXCLUDED.status,
  updated_at = now();

-- Test sign-in identities: provider 'test', subject = fixture key.
INSERT INTO identity_link (user_id, provider, tenant_id, subject)
VALUES
  ('00000000-0000-4000-8000-000000000103', 'test', '', 'admin'),
  ('00000000-0000-4000-8000-000000000104', 'test', '', 'lab'),
  ('00000000-0000-4000-8000-000000000102', 'test', '', 'at'),
  ('00000000-0000-4000-8000-000000000101', 'test', '', 'pe'),
  ('00000000-0000-4000-8000-000000000105', 'test', '', 'de'),
  ('00000000-0000-4000-8000-000000000106', 'test', '', 'js-tech'),
  ('00000000-0000-4000-8000-000000000107', 'test', '', 'js-eng')
ON CONFLICT (provider, tenant_id, subject) DO UPDATE SET user_id = EXCLUDED.user_id;

-- Roles: Admin (test) is admin only; Lab (test) is Lab Manager only. Neither has project authority.
DELETE FROM role_assignment
WHERE user_id IN ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000104');
INSERT INTO role_assignment (user_id, role)
VALUES
  ('00000000-0000-4000-8000-000000000103', 'admin'),
  ('00000000-0000-4000-8000-000000000104', 'lab_manager');

INSERT INTO project (id, project_number, name, client, pm_pe_user_id)
VALUES (
  '00000000-0000-4000-8000-000000000201',
  'DEMO-2601',
  'Riverbank investigation',
  'Example Client',
  '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO test_hole (id, project_id, name)
VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201', 'TH26-01'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000201', 'TH26-02')
ON CONFLICT (id) DO NOTHING;
