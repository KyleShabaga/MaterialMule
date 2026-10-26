-- Reference data for every environment, including production. Idempotent.
-- Production otherwise starts empty: no projects and no people (D42); only the shared LAB account.

INSERT INTO location (code, name, kind, is_system, active)
VALUES ('RECEIVING', 'Receiving lab', 'receiving_lab', true, true)
ON CONFLICT (code_normalized) DO NOTHING;

-- The operational shared receiving account LAB (TRP-T06). It exists everywhere but can't sign in
-- until an administrator sets its password (POST /api/admin/lab/password). It is not a Microsoft
-- account and is unrelated to the development-only "Lab (test)" identity.
INSERT INTO app_user (id, display_name, account_type, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'LAB', 'shared_lab', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity_link (user_id, provider, tenant_id, subject)
VALUES ('00000000-0000-4000-8000-000000000001', 'local_lab', '', 'LAB')
ON CONFLICT (provider, tenant_id, subject) DO NOTHING;
