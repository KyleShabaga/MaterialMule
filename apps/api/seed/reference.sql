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

-- Company holiday calendar (MM-V2-C37, owner decision 2026-11-08): the Alberta general holidays
-- for 2026–2028. A concrete specimen target on one of these dates is flagged like a weekend and
-- never moved. Source: Government of Alberta, Employment Standards "General holidays and general
-- holiday pay" (alberta.ca/general-holidays-and-general-holiday-pay): New Year's Day, Alberta
-- Family Day (3rd Monday of February), Good Friday, Victoria Day (the Monday before May 25),
-- Canada Day, Labour Day (1st Monday of September), Thanksgiving Day (2nd Monday of October),
-- Remembrance Day and Christmas Day. The optional Alberta holidays (Easter Monday, Heritage Day,
-- National Day for Truth and Reconciliation, Boxing Day) are NOT seeded: an admin adds any the
-- firm observes in Settings → Holidays. Dates are the calendar dates themselves (a holiday on a
-- weekend is not shifted to an observed weekday). Fixed IDs, so an admin's later rename or removal
-- is never undone by re-running this. Add the next year here each year.
DO $$
BEGIN
  IF to_regclass('company_holiday') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO company_holiday (id, holiday_on, name, source)
  VALUES
    ('00000000-0000-4000-8000-000c37202601', '2026-01-01', 'New Year''s Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202602', '2026-02-16', 'Alberta Family Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202603', '2026-04-03', 'Good Friday', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202604', '2026-05-18', 'Victoria Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202605', '2026-07-01', 'Canada Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202606', '2026-09-07', 'Labour Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202607', '2026-10-12', 'Thanksgiving Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202608', '2026-11-11', 'Remembrance Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202609', '2026-12-25', 'Christmas Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202701', '2027-01-01', 'New Year''s Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202702', '2027-02-15', 'Alberta Family Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202703', '2027-03-26', 'Good Friday', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202704', '2027-05-24', 'Victoria Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202705', '2027-07-01', 'Canada Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202706', '2027-09-06', 'Labour Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202707', '2027-10-11', 'Thanksgiving Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202708', '2027-11-11', 'Remembrance Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202709', '2027-12-25', 'Christmas Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202801', '2028-01-01', 'New Year''s Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202802', '2028-02-21', 'Alberta Family Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202803', '2028-04-14', 'Good Friday', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202804', '2028-05-22', 'Victoria Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202805', '2028-07-01', 'Canada Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202806', '2028-09-04', 'Labour Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202807', '2028-10-09', 'Thanksgiving Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202808', '2028-11-11', 'Remembrance Day', 'alberta_general'),
    ('00000000-0000-4000-8000-000c37202809', '2028-12-25', 'Christmas Day', 'alberta_general')
  ON CONFLICT DO NOTHING;
END
$$;

-- Report template revisions (MM-V2-C32). P1 is the provisional design the owner directed on
-- 2026-11-09 ("V2 Concrete — Provisional report designs (G2, 2026-11-09)") in place of the
-- office's report examples; those, when supplied, become a new revision (never an edit of P1).
-- Fixed IDs; in force from 2026-11-09 (America/Edmonton). Skipped before migration 0031.
DO $$
BEGIN
  IF to_regclass('concrete_report_template') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO concrete_report_template
    (id, report_kind, revision, name, provisional, design_reference, in_force_from)
  VALUES
    ('00000000-0000-4000-8000-000c32000001', 'field', 'P1', 'Field report template', true,
     'V2 Concrete — Provisional report designs (G2, 2026-11-09), section 3',
     '2026-11-09T00:00:00-07:00'),
    ('00000000-0000-4000-8000-000c32000002', 'strength', 'P1', 'Strength report template', true,
     'V2 Concrete — Provisional report designs (G2, 2026-11-09), section 4',
     '2026-11-09T00:00:00-07:00'),
    ('00000000-0000-4000-8000-000c32000003', 'summary', 'P1', 'Summary report template', true,
     'V2 Concrete — Provisional report designs (G2, 2026-11-09), section 5',
     '2026-11-09T00:00:00-07:00')
  ON CONFLICT DO NOTHING;
END
$$;
