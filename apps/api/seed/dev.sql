-- Fictional development/test fixtures. Never run in production (the CLI refuses).
-- Fixed UUIDs keep audit references stable: re-running this file (npm run db:reset:dev) restores
-- fixture profile fields and roles but never changes an ID or touches audit history.
-- Sign-in keys must match apps/api/src/auth/test-provider/fixtures.ts (MM-T33).

INSERT INTO app_user (id, display_name, given_name, surname, official_initials, position, account_type, status)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'Pat Example',  'Pat',    'Example', 'PE',  'project_engineer',       'test', 'active'),
  ('00000000-0000-4000-8000-000000000102', 'Alex Tester',  'Alex',   'Tester',  'AT',  'technician',  'test', 'active'),
  ('00000000-0000-4000-8000-000000000103', 'Admin (test)', 'Admin',  'Test',    'ADM', NULL,          'test', 'active'),
  ('00000000-0000-4000-8000-000000000104', 'Lab (test)',   'Lab',    'Test',    'LAB', 'lab_manager', 'test', 'active'),
  ('00000000-0000-4000-8000-000000000105', 'Dana Example', 'Dana',   'Example', 'DE',  'engineer',    'test', 'active'),
  -- Two staff sharing the initials JS, to exercise duplicate-initial handling (MM-T07).
  ('00000000-0000-4000-8000-000000000106', 'Jordan Smith', 'Jordan', 'Smith',   'JS',  'technician',  'test', 'active'),
  ('00000000-0000-4000-8000-000000000107', 'Jamie Song',   'Jamie',  'Song',    'JS',  'engineer',    'test', 'active'),
  -- Pending applicants with no sign-in identity, for the staff approval flow (MM-T07): one per
  -- E2E viewport so parallel runs never approve the same person. Re-seeding makes them pending.
  ('00000000-0000-4000-8000-000000000108', 'Riley Pending', 'Riley', 'Pending', NULL,  NULL,         'test', 'pending'),
  ('00000000-0000-4000-8000-000000000109', 'Casey Pending', 'Casey', 'Pending', NULL,  NULL,         'test', 'pending')
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  given_name = EXCLUDED.given_name,
  surname = EXCLUDED.surname,
  official_initials = EXCLUDED.official_initials,
  position = EXCLUDED.position,
  account_type = EXCLUDED.account_type,
  status = EXCLUDED.status,
  approved_by = NULL,
  approved_at = NULL,
  disabled_reason = NULL,
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

INSERT INTO project (id, project_number, name, client, lead_project_engineer_user_id)
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

-- Inventory demo (MM-T12): a second project, a warehouse location and a few storage units with
-- 2024 IDs (below 100000, so they never collide with IDs the app issues or E2E inserts). Fixed IDs;
-- re-running changes nothing.
INSERT INTO project (id, project_number, name, client, lead_project_engineer_user_id)
VALUES (
  '00000000-0000-4000-8000-000000000202',
  'DEMO-2602',
  'Hillside bridge',
  'Sample Roads Ltd',
  '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO test_hole (id, project_id, name)
VALUES ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000202', 'TH26-01')
ON CONFLICT (id) DO NOTHING;

-- Receiving lab is reference data (seed/reference.sql); repeated here so this file also works alone.
INSERT INTO location (code, name, kind, is_system, active)
VALUES ('RECEIVING', 'Receiving lab', 'receiving_lab', true, true)
ON CONFLICT (code_normalized) DO NOTHING;

INSERT INTO location (id, code, name, kind)
VALUES ('00000000-0000-4000-8000-000000000401', 'WH-C2', 'Warehouse C2', 'warehouse')
ON CONFLICT (code_normalized) DO NOTHING;

INSERT INTO receipt (id, project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                     receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                     request_hash, description)
VALUES
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000201', '2024-10-23',
   '00000000-0000-4000-8000-000000000102', 'AT', 'Alex Tester', '00000000-0000-4000-8000-000000000102',
   3, '00000000-0000-4000-8000-000000000611', 'dev-seed', 'Demo: three buckets from TH26-01/02'),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000202', '2024-11-04',
   '00000000-0000-4000-8000-000000000102', 'AT', 'Alex Tester', '00000000-0000-4000-8000-000000000102',
   2, '00000000-0000-4000-8000-000000000612', 'dev-seed', 'Demo: bridge borehole material')
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage_unit (id, readable_id, id_prefix, issued_year, issued_holder_kind, receipt_id,
                          project_id, unit_type, holder_kind, current_location_id, status,
                          received_date, receipt_line, note)
SELECT u.id, u.readable_id, u.prefix, 2024, u.holder, u.receipt_id, u.project_id, u.unit_type,
       u.holder, l.id, u.status, u.received_date::date, u.line, u.note
FROM (VALUES
  ('00000000-0000-4000-8000-000000000701'::uuid, 'BKT-2024-000001', 'BKT', 'bucket', 'bucket',
   '00000000-0000-4000-8000-000000000601'::uuid, '00000000-0000-4000-8000-000000000201'::uuid,
   'WH-C2', 'in_stock', '2024-10-23', 1, NULL),
  ('00000000-0000-4000-8000-000000000702'::uuid, 'BKT-2024-000002', 'BKT', 'bucket', 'bucket',
   '00000000-0000-4000-8000-000000000601'::uuid, '00000000-0000-4000-8000-000000000201'::uuid,
   'RECEIVING', 'in_stock', '2024-10-23', 2, 'Lid cracked'),
  ('00000000-0000-4000-8000-000000000703'::uuid, 'BKT-2024-000003', 'BKT', 'bucket', 'bucket',
   '00000000-0000-4000-8000-000000000601'::uuid, '00000000-0000-4000-8000-000000000201'::uuid,
   'WH-C2', 'disposed', '2024-10-23', 3, NULL),
  ('00000000-0000-4000-8000-000000000704'::uuid, 'ST-2024-000001', 'ST', 'shelby_tube', 'shelby_tube',
   '00000000-0000-4000-8000-000000000602'::uuid, '00000000-0000-4000-8000-000000000202'::uuid,
   'WH-C2', 'in_stock', '2024-11-04', 1, NULL),
  ('00000000-0000-4000-8000-000000000705'::uuid, 'BKT-2024-000004', 'BKT', 'bucket', 'bucket',
   '00000000-0000-4000-8000-000000000602'::uuid, '00000000-0000-4000-8000-000000000202'::uuid,
   'RECEIVING', 'approved_for_disposal', '2024-11-04', 2, NULL)
) AS u(id, readable_id, prefix, holder, unit_type, receipt_id, project_id, location_code, status,
       received_date, line, note)
JOIN location l ON l.code_normalized = u.location_code
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage_unit_hole_summary (id, storage_unit_id, project_id, test_hole_id, summary_type,
                                       sample_from, sample_to, depth_from, depth_to, depth_unit,
                                       custom_text)
VALUES
  ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000701',
   '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301',
   'sample_range', 'G1', 'S12', NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000802', '00000000-0000-4000-8000-000000000702',
   '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301',
   'sample_range', 'G13', 'S32', NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000803', '00000000-0000-4000-8000-000000000702',
   '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000302',
   'depth_range', NULL, NULL, 0, 1.5, 'm', NULL),
  ('00000000-0000-4000-8000-000000000804', '00000000-0000-4000-8000-000000000703',
   '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000302',
   'all', NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000805', '00000000-0000-4000-8000-000000000704',
   '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000303',
   'depth_range', NULL, NULL, 3, 5, 'ft', NULL),
  ('00000000-0000-4000-8000-000000000806', '00000000-0000-4000-8000-000000000705',
   '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000303',
   'custom', NULL, NULL, NULL, NULL, NULL, 'Bulk bag, west abutment')
ON CONFLICT (id) DO NOTHING;

-- Fictional lab catalogue entries for development and E2E (MM-T23). Codes start with DEMO- so
-- they can't be mistaken for the owner's workbook codes, which are not seeded until reconciled.
-- Added only where the Soils group (reference data) exists.
INSERT INTO test_type (id, group_id, code, name, description, sort_order)
SELECT t.id::uuid, g.id, t.code, t.name, t.description, t.sort_order
FROM (VALUES
  ('00000000-0000-4000-8000-00000000c201', 'DEMO-MC', 'Moisture Content (demo)',
   'Moisture content of soil - fictional development fixture', 1),
  ('00000000-0000-4000-8000-00000000c202', 'DEMO-VI', 'Visual Identification (demo)',
   'Visual identification of soil - fictional development fixture', 2),
  ('00000000-0000-4000-8000-00000000c203', 'DEMO-ATT', 'Atterberg Limits (demo)',
   'Liquid and plastic limits - fictional development fixture', 3)
) AS t(id, code, name, description, sort_order)
JOIN test_group g ON g.id = '00000000-0000-4000-8000-00000000c101'
ON CONFLICT DO NOTHING;
