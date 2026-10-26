-- Fictional development/test fixtures. Never run in production (the CLI refuses).
-- Fixed UUIDs keep audit references stable across re-seeding. Idempotent.
-- TRP-T33 adds the Admin (test) and Lab (test) sign-in identities on top of these.

INSERT INTO app_user (id, display_name, given_name, surname, official_initials, position, account_type, status)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'Pat Example', 'Pat', 'Example', 'PE', 'pm_pe', 'test', 'active'),
  ('00000000-0000-4000-8000-000000000102', 'Alex Tester', 'Alex', 'Tester', 'AT', 'technician', 'test', 'active')
ON CONFLICT (id) DO NOTHING;

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
