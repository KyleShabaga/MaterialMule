-- Reference data for every environment, including production. Idempotent.
-- Production otherwise starts empty: no projects and no people (D42); only the shared LAB account.

INSERT INTO location (code, name, kind, is_system, active)
VALUES ('RECEIVING', 'Receiving lab', 'receiving_lab', true, true)
ON CONFLICT (code_normalized) DO NOTHING;

-- The operational shared receiving account LAB (MM-T06). It exists everywhere but can't sign in
-- until an administrator sets its password (POST /api/admin/lab/password). It is not a Microsoft
-- account and is unrelated to the development-only "Lab (test)" identity.
INSERT INTO app_user (id, display_name, account_type, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'LAB', 'shared_lab', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity_link (user_id, provider, tenant_id, subject)
VALUES ('00000000-0000-4000-8000-000000000001', 'local_lab', '', 'LAB')
ON CONFLICT (provider, tenant_id, subject) DO NOTHING;

-- Lab test catalogue groups the owner named for the first catalogue (MM-T23, 2026-10-27): Soils
-- and Advanced Soils only. Fixed IDs, so a Lab Manager's later rename or reorder is never undone
-- by re-running this. Test entries are NOT seeded: they come from the owner's workbook once its
-- rows are extracted and reconciled (no invented codes, no costs). Skipped on a database migrated
-- only to an earlier version (upgrade tests seed reference data at older schema versions).
DO $$
BEGIN
  IF to_regclass('test_group') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO test_group (id, name, sort_order)
  VALUES ('00000000-0000-4000-8000-00000000c101', 'Soils', 1),
         ('00000000-0000-4000-8000-00000000c102', 'Advanced Soils', 2)
  ON CONFLICT DO NOTHING;

  -- Starter template (MM-T23). It has no tests until the verified catalogue exists: Visual
  -- Identification and Moisture Content are added from the workbook's codes, never invented.
  INSERT INTO test_template (id, name)
  VALUES ('00000000-0000-4000-8000-00000000c111', 'Geotechnical – VI + Moisture Content')
  ON CONFLICT DO NOTHING;
END
$$;
