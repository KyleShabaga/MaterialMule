-- MM-AO02: clean pre-release schema baseline.
--
-- This one file replaces the pre-release migration lineage 0001_initial_schema … 0078 (owner
-- decision 2026-10-29: the application has never been deployed). It creates the same tables,
-- constraints, indexes, functions and triggers that lineage ended with, under Lead Project
-- Engineer naming, folded into one reviewed definition per object: later columns sit in their
-- table, each function and trigger appears once in its final form, and upgrade-only backfills are
-- gone because a baseline always starts empty. The last section adds the MM-AO02 project
-- assignment and scoped-grant storage. docs/database.md "Clean baseline" records the mapping.
--
-- Forward-only migrations resume after this file: never edit it once it is applied anywhere;
-- write 0002_… instead. A database built from the retired lineage is refused by the migrator and
-- is rebuilt only if it is an explicitly designated disposable development or test database.
--
-- Integrity rules live here (FKs, checks, unique indexes, triggers) so invalid states can't be
-- stored even if application code has a bug. No individual sample table: receiving is per storage
-- unit. Enumerations are text + CHECK rather than PostgreSQL enum types so later migrations can
-- extend them without ALTER TYPE. Ticket references (TRP-T…, MM-T…) name the card that introduced
-- each rule.

-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it. It lives in
-- public so every schema (including per-test-file schemas) shares one copy.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- ---------------------------------------------------------------------------------------------
-- People, identities, roles and sessions (TRP-T02, T05, T06, T07)
-- ---------------------------------------------------------------------------------------------

-- People are keyed on (tenant ID, object ID) in identity_link; the profile fields below may change
-- without creating a new user.
CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  given_name         text CHECK (length(given_name) <= 100),
  surname            text CHECK (length(surname) <= 100),
  work_email         text CHECK (length(work_email) <= 320),
  sign_in_username   text CHECK (length(sign_in_username) <= 320),
  -- Official initials are confirmed by an admin; they are not unique (two "JS" staff can exist).
  official_initials  text CHECK (official_initials ~ '^[A-Z]{1,5}$'),
  -- First-login position choice: job metadata that grants nothing (MM-T05).
  position           text CHECK (position IN ('technician', 'engineer', 'project_engineer', 'lab_manager')),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'shared_lab', 'test')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Microsoft profile (TRP-T05). job_title is the Graph value; it grants nothing.
  job_title                      text CHECK (length(job_title) <= 200),
  department                     text CHECK (length(department) <= 200),
  office_location                text CHECK (length(office_location) <= 200),
  -- Where the profile fields last came from, and when they were last refreshed successfully.
  profile_source                 text
                                   CHECK (profile_source IN ('microsoft_graph', 'microsoft_id_token', 'seed')),
  profile_refreshed_at           timestamptz,
  -- Set when the latest refresh failed (the stored values are then the last known ones).
  profile_refresh_failed_at      timestamptz,
  -- First-login position choice: saved once, never set by a profile refresh.
  position_set_at                timestamptz,
  -- Official initials are confirmed by an admin (TRP-T07); refresh never writes them.
  initials_confirmed_by_user_id  uuid REFERENCES app_user (id),
  initials_confirmed_at          timestamptz,
  -- Staff directory (TRP-T07). Work email / UPN an admin expects this person to sign in with.
  -- Compared case-insensitively (Entra UPNs are case-insensitive); never matched on initials or
  -- name, and only until that person's first Microsoft sign-in links it.
  expected_upn     text CHECK (expected_upn = btrim(expected_upn)
                                 AND length(expected_upn) BETWEEN 3 AND 320
                                 AND expected_upn ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  approved_by      uuid REFERENCES app_user (id),
  approved_at      timestamptz,
  disabled_reason  text CHECK (length(btrim(disabled_reason)) BETWEEN 1 AND 2000),
  -- D16 (MM-AO02): an administrator's audited override of the Microsoft Graph job title. It takes
  -- precedence for display; both values are kept and labelled by source; neither grants authority.
  job_title_override               text CHECK (job_title_override = btrim(job_title_override)
                                               AND length(job_title_override) BETWEEN 1 AND 200),
  job_title_override_set_by_user_id uuid REFERENCES app_user (id),
  job_title_override_set_at        timestamptz,
  CONSTRAINT app_user_job_title_override_set_check
    CHECK ((job_title_override_set_at IS NULL) = (job_title_override_set_by_user_id IS NULL)
           AND (job_title_override IS NULL OR job_title_override_set_at IS NOT NULL)),
  CONSTRAINT app_user_position_set_has_position CHECK (position_set_at IS NULL OR position IS NOT NULL),
  CONSTRAINT app_user_initials_confirmation_complete
    CHECK ((initials_confirmed_by_user_id IS NULL) = (initials_confirmed_at IS NULL)),
  -- Approval is recorded together: who and when.
  CONSTRAINT app_user_approval_pair_check
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- A disable reason belongs only to a disabled account; re-enabling clears it (the audit keeps it).
  CONSTRAINT app_user_disabled_reason_status_check
    CHECK (disabled_reason IS NULL OR status = 'disabled')
);
CREATE UNIQUE INDEX app_user_expected_upn_key
  ON app_user (lower(expected_upn)) WHERE expected_upn IS NOT NULL;
-- Receiver search filters active staff by initials; names use a lower() scan (small table).
CREATE INDEX app_user_status_initials_idx ON app_user (status, official_initials);

CREATE TABLE identity_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  provider    text NOT NULL CHECK (provider IN ('microsoft', 'local_lab', 'test')),
  -- Empty string for providers without tenants so the unique constraint below always applies.
  tenant_id   text NOT NULL DEFAULT '',
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_link_provider_subject_key UNIQUE (provider, tenant_id, subject),
  -- A Microsoft identity is a tenant GUID plus an immutable object ID (oid) GUID.
  CONSTRAINT identity_link_microsoft_shape CHECK (
    provider <> 'microsoft'
    OR (tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
);
CREATE INDEX identity_link_user_idx ON identity_link (user_id);
-- A person has at most one Microsoft identity.
CREATE UNIQUE INDEX identity_link_one_microsoft_per_user
  ON identity_link (user_id) WHERE provider = 'microsoft';

-- Global app roles. Job titles and positions are separate metadata and grant nothing.
CREATE TABLE role_assignment (
  user_id     uuid NOT NULL REFERENCES app_user (id),
  role        text NOT NULL CHECK (role IN ('admin', 'lab_manager')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id),
  -- Only a hash of the session token is stored (T04).
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX session_user_idx ON session (user_id);

-- Shared receiving account LAB (TRP-T06) signs in with an app-managed password (provider
-- local_lab), never a Microsoft account. One password per shared (local) account. Only an Argon2id
-- PHC string is stored; it records its own cost, so the cost can rise later without a migration.
CREATE TABLE local_credential (
  user_id             uuid PRIMARY KEY REFERENCES app_user (id),
  password_hash       text NOT NULL
                        CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES app_user (id)
);

-- Personal and test accounts never get an app-managed password.
CREATE FUNCTION local_credential_is_for_shared_lab() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND account_type = 'shared_lab') THEN
    RAISE EXCEPTION 'local_credential is only for shared_lab accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER local_credential_shared_lab_only
  BEFORE INSERT OR UPDATE ON local_credential
  FOR EACH ROW EXECUTE FUNCTION local_credential_is_for_shared_lab();

-- Brute-force protection for local sign-in: failures per key (the account and the client
-- address) within a window, and a temporary lockout once the limit is reached.
CREATE TABLE sign_in_throttle (
  throttle_key       text PRIMARY KEY CHECK (length(throttle_key) BETWEEN 1 AND 200),
  failed_count       integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  locked_until       timestamptz
);

-- In-flight Microsoft sign-ins (authorization-code flow with PKCE). Short-lived and single-use;
-- only hashes of the state and of the browser-binding cookie are stored.
CREATE TABLE oidc_sign_in_attempt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL CHECK (provider = 'microsoft'),
  state_hash            bytea NOT NULL UNIQUE,
  browser_binding_hash  bytea NOT NULL,
  nonce                 text NOT NULL,
  code_verifier         text NOT NULL,
  return_to             text NOT NULL
                          CHECK (return_to ~ '^/' AND return_to !~ '^//' AND length(return_to) <= 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX oidc_sign_in_attempt_expires_idx ON oidc_sign_in_attempt (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Projects and test holes (TRP-T02, T08, T35)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE project (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored exactly as entered once trimmed; uniqueness ignores case.
  project_number                 text NOT NULL
                                   CHECK (project_number = btrim(project_number)
                                          AND length(project_number) BETWEEN 1 AND 40),
  project_number_normalized      text GENERATED ALWAYS AS (lower(project_number)) STORED,
  name                           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  client                         text NOT NULL CHECK (length(btrim(client)) BETWEEN 1 AND 200),
  -- The project's Lead Project Engineer: its sole project leadership assignment (owner decision
  -- 2026-10-29). Required and effective from creation until MM-AO04 introduces nomination and
  -- unassigned projects (D01/D02); only an admin changes it, with a reason.
  lead_project_engineer_user_id  uuid NOT NULL REFERENCES app_user (id),
  -- The single legacy review-engineer field. It routes "Only mine" and nothing else: it is not a
  -- reviewer qualification or issuer grant (MM-AO02 compatibility; see project_reviewer_assignment).
  review_engineer_user_id        uuid REFERENCES app_user (id),
  server_folder_path             text CHECK (length(server_folder_path) <= 500),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  version                        integer NOT NULL DEFAULT 1,
  CONSTRAINT project_number_key UNIQUE (project_number_normalized)
);
CREATE INDEX project_name_lower_idx ON project (lower(name));
-- Receiving pickers search by prefix first ("679" -> 67997, "pine" -> Pine Creek): the unique and
-- lower(name) indexes use the database collation, which LIKE 'abc%' can't use; these can (TRP-T08).
CREATE INDEX project_number_prefix_idx ON project (project_number_normalized text_pattern_ops);
CREATE INDEX project_name_prefix_idx ON project (lower(name) text_pattern_ops);
-- The projects list searches number, name and client (contains, ignoring case) and filters "Only
-- mine" (Lead Project Engineer or review engineer) (TRP-T35).
CREATE INDEX project_number_trgm_idx ON project USING gin (project_number_normalized public.gin_trgm_ops);
CREATE INDEX project_name_trgm_idx ON project USING gin (lower(name) public.gin_trgm_ops);
CREATE INDEX project_client_trgm_idx ON project USING gin (lower(client) public.gin_trgm_ops);
CREATE INDEX project_lead_project_engineer_idx ON project (lead_project_engineer_user_id);
CREATE INDEX project_review_engineer_idx ON project (review_engineer_user_id)
  WHERE review_engineer_user_id IS NOT NULL;

CREATE TABLE test_hole (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES project (id),
  -- Names such as TH26-01, BH-01, TP-03 are kept as assigned; never rewritten.
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 40
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_hole_project_name_key UNIQUE (project_id, name_normalized),
  -- Target of composite FKs that keep summaries inside one project.
  CONSTRAINT test_hole_project_id_key UNIQUE (project_id, id)
);
CREATE INDEX test_hole_name_prefix_idx ON test_hole (project_id, name_normalized text_pattern_ops);

-- ---------------------------------------------------------------------------------------------
-- Locations (TRP-T02, MM-T37)
-- ---------------------------------------------------------------------------------------------
--
-- Optional area/group, retirement (when, why), optimistic version, and two label facts kept apart
-- on purpose:
-- * code_locked_at: set in the same transaction as the location's FIRST label print request.
--   From then on the code (and so the LOC-<CODE> payload) can never change, whatever happens to
--   the job: a queued, sending or uncertain job may already be on a shelf edge.
-- * label_printed_at: set only when a person confirms a location label physically came out
--   (print_job.physically_confirmed_at). Queuing or sending a job never sets it.
--
-- Retirement hides a location from new moves but keeps every reference to it (history, audit,
-- print jobs) readable. Units can't be placed in a retired location: storage_unit inserts and
-- location changes lock the destination row (FOR KEY SHARE) and re-read `active`, and retirement
-- locks it FOR UPDATE before counting occupants, so a retirement and an incoming move are
-- serialised whichever starts first.

CREATE TABLE location (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL
                     CHECK (code = btrim(code) AND code ~ '^[A-Za-z0-9-]{2,20}$'),
  code_normalized  text GENERATED ALWAYS AS (upper(code)) STORED,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind             text NOT NULL
                     CHECK (kind IN ('receiving_lab', 'lab', 'staging', 'warehouse', 'other')),
  is_system        boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  area             text
                     CONSTRAINT location_area_check
                     CHECK (area = btrim(area) AND length(area) BETWEEN 1 AND 60),
  retired_at       timestamptz,
  retired_reason   text
                     CONSTRAINT location_retired_reason_check
                     CHECK (length(btrim(retired_reason)) BETWEEN 1 AND 500),
  code_locked_at   timestamptz,
  label_printed_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CONSTRAINT location_version_check CHECK (version >= 1),
  CONSTRAINT location_code_key UNIQUE (code_normalized),
  -- A system location (Receiving lab) can never be retired.
  CHECK (NOT is_system OR active),
  -- Retired exactly when inactive, with a reason.
  CONSTRAINT location_retirement_check CHECK (
    active = (retired_at IS NULL) AND (retired_at IS NULL) = (retired_reason IS NULL)
  ),
  -- A physical confirmation implies the code was locked by a print request.
  CONSTRAINT location_label_printed_check CHECK (
    label_printed_at IS NULL OR code_locked_at IS NOT NULL
  )
);
CREATE INDEX location_name_idx ON location (lower(name));

-- Integrity rules the application also checks, enforced here so a bug can't break them.
CREATE FUNCTION location_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Locations are retired, never deleted: history, audit and print jobs keep naming them.
    RAISE EXCEPTION 'location % can''t be deleted; retire it instead', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'location % system flag can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.is_system AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'system location % kind can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.code_locked_at IS NOT NULL AND (
    NEW.code IS DISTINCT FROM OLD.code OR NEW.code_locked_at IS DISTINCT FROM OLD.code_locked_at
  ) THEN
    RAISE EXCEPTION 'location % code is locked: a label has been requested for it', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.label_printed_at IS NOT NULL AND NEW.label_printed_at IS DISTINCT FROM OLD.label_printed_at THEN
    RAISE EXCEPTION 'location % first physical label confirmation can''t change', OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_guard
  BEFORE UPDATE OR DELETE ON location
  FOR EACH ROW EXECUTE FUNCTION location_guard();

-- ---------------------------------------------------------------------------------------------
-- Receipts, bulk-sample groups and storage units (TRP-T02, T09, MM-T36, T47)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE receipt (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES project (id),
  -- Original receipt header; later unit corrections don't rewrite it (D46/D47).
  received_date               date NOT NULL,
  receiver_user_id            uuid NOT NULL REFERENCES app_user (id),
  receiver_initials_snapshot  text NOT NULL CHECK (length(receiver_initials_snapshot) BETWEEN 1 AND 5),
  receiver_name_snapshot      text NOT NULL CHECK (length(receiver_name_snapshot) BETWEEN 1 AND 200),
  -- The authenticated account that confirmed (e.g. LAB), kept separate from the receiver.
  account_user_id             uuid NOT NULL REFERENCES app_user (id),
  description                 text CHECK (length(description) <= 2000),
  -- Physical storage units in the receipt (D41); owner limit of 50 per receipt (2026-10-25).
  quantity                    integer NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  confirmed_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_project_idx ON receipt (project_id, received_date);

-- The project number is printed on storage unit labels, so it can't change once any receipt
-- exists for the project (owner decision 2026-10-25). The API answers 422 first; this is the
-- backstop. Changing the number rewrites the unique key, so the UPDATE's row lock conflicts with
-- the key-share lock a concurrent receipt insert takes on the project, and the check below sees
-- that receipt once it commits.
CREATE FUNCTION project_number_locked_after_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_number IS DISTINCT FROM OLD.project_number
     AND EXISTS (SELECT 1 FROM receipt WHERE project_id = OLD.id) THEN
    RAISE EXCEPTION 'project % number is printed on existing labels', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_number_locked
  BEFORE UPDATE OF project_number ON project
  FOR EACH ROW EXECUTE FUNCTION project_number_locked_after_receipt();

-- One counter per prefix and issuance year (T03 allocates from it).
CREATE TABLE storage_unit_annual_counter (
  prefix      text NOT NULL CHECK (prefix IN ('CT', 'BKT', 'ST', 'CRE')),
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_value  integer NOT NULL DEFAULT 0 CHECK (last_value BETWEEN 0 AND 999999),
  PRIMARY KEY (prefix, year)
);

-- Bulk-sample groups of physical buckets (MM-T36).
--
-- Sampling source vs storage location: the source (a same-project test hole, or a free-text
-- standalone sampling location) is where the material came from; current_location_id is where
-- the physical unit is now. They are never the same column.
--
-- Bulk soil bucket (unit_type bulk_container, holder bucket, BKT- ID): the bulk_container unit
-- type means "bucket holding a bulk soil sample". The physical holder is still a bucket (BKT-),
-- never a generic CT container. Its only contents summary is its bulk group's identity: project,
-- source, required sample reference (usually B1, B2…, never forced), required depth (single or
-- interval) with units, optional description. The identity is stored once on bulk_group and
-- inherited by every member bucket. A group's ID is a random UUID: no group letters, and B1 is not
-- unique (another hole or location may have its own B1). "Bucket n of N" is computed when read
-- (received date, then readable ID) and never stored.
CREATE TABLE bulk_group (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                 uuid NOT NULL REFERENCES project (id),
  source_type                text NOT NULL
                               CHECK (source_type IN ('test_hole', 'standalone_location')),
  test_hole_id               uuid,
  source_location_reference  text
                               CHECK (source_location_reference = btrim(source_location_reference)
                                      AND length(source_location_reference) BETWEEN 1 AND 100
                                      AND source_location_reference !~ '[[:cntrl:]]'),
  -- Field sample reference as entered, e.g. B1. Usually B-prefixed; never forced.
  sample_reference           text NOT NULL
                               CHECK (sample_reference = btrim(sample_reference)
                                      AND length(sample_reference) BETWEEN 1 AND 40
                                      AND sample_reference !~ '[[:cntrl:]]'),
  depth_from                 numeric(8, 2) NOT NULL CHECK (depth_from >= 0),
  -- Null for a single depth.
  depth_to                   numeric(8, 2),
  depth_unit                 text NOT NULL CHECK (depth_unit IN ('ft', 'm')),
  description                text CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  created_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  -- The receipt that created the group and the key it used for it, so a retried confirmation
  -- returns the same group IDs. Null for a group created by a membership correction.
  created_receipt_id         uuid REFERENCES receipt (id),
  receipt_group_key          text CHECK (length(receipt_group_key) BETWEEN 1 AND 64),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- Bumped by every identity correction; a receipt joining the group names the version it showed.
  version                    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT bulk_group_project_id_key UNIQUE (project_id, id),
  -- The source hole belongs to the group's project.
  CONSTRAINT bulk_group_test_hole_fk FOREIGN KEY (project_id, test_hole_id)
    REFERENCES test_hole (project_id, id),
  CONSTRAINT bulk_group_source_check CHECK (
    (source_type = 'test_hole' AND test_hole_id IS NOT NULL AND source_location_reference IS NULL)
    OR (source_type = 'standalone_location' AND test_hole_id IS NULL
        AND source_location_reference IS NOT NULL)
  ),
  CONSTRAINT bulk_group_depth_check CHECK (depth_to IS NULL OR depth_to >= depth_from),
  CONSTRAINT bulk_group_receipt_key_check
    CHECK ((created_receipt_id IS NULL) = (receipt_group_key IS NULL)),
  CONSTRAINT bulk_group_receipt_key_key UNIQUE (created_receipt_id, receipt_group_key)
);
CREATE INDEX bulk_group_project_idx ON bulk_group (project_id, created_at);
CREATE INDEX bulk_group_test_hole_idx ON bulk_group (test_hole_id);

-- A group stays in its project; members follow from that (their FK carries the project).
CREATE FUNCTION bulk_group_project_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'bulk group % project can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bulk_group_project_immutable
  BEFORE UPDATE OF project_id ON bulk_group
  FOR EACH ROW EXECUTE FUNCTION bulk_group_project_is_immutable();

-- A storage unit's sample identity (MM-T36). Shelby tube (unit_type shelby_tube, holder
-- shelby_tube, ST- ID): the source and the optional sample reference and depth live on the unit
-- itself. A standalone source is free text on that unit only: there is no directory of standalone
-- locations (owner decision 2026-10-27), and two units with the same text are never merged into
-- one source. A unit has exactly one kind of contents summary: hole summaries (ordinary bucket),
-- its own sample identity (Shelby tube with a source) or its bulk group (bulk soil bucket).
CREATE TABLE storage_unit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Readable, permanent ID printed on labels, e.g. BKT-2026-000001. Never changes after issue.
  readable_id         text NOT NULL UNIQUE
                        CHECK (readable_id ~ '^(CT|BKT|ST|CRE)-[0-9]{4}-[0-9]{6}$'),
  id_prefix           text NOT NULL CHECK (id_prefix IN ('CT', 'BKT', 'ST', 'CRE')),
  issued_year         integer NOT NULL CHECK (issued_year BETWEEN 2000 AND 9999),
  -- The physical holder at confirmation decides the prefix; kept immutable with the ID.
  issued_holder_kind  text NOT NULL
                        CHECK (issued_holder_kind IN ('bucket', 'shelby_tube', 'core_box', 'generic')),
  receipt_id          uuid NOT NULL REFERENCES receipt (id),
  project_id          uuid NOT NULL REFERENCES project (id),
  -- Current values; correctable later (D45) without touching the ID.
  -- core_box unit type is deliberately absent until core-box tracking is approved (D11).
  unit_type           text NOT NULL CHECK (unit_type IN ('bucket', 'shelby_tube', 'bulk_container')),
  holder_kind         text NOT NULL
                        CHECK (holder_kind IN ('bucket', 'shelby_tube', 'core_box', 'generic')),
  note                text CHECK (length(note) <= 2000),
  current_location_id uuid NOT NULL REFERENCES location (id),
  status              text NOT NULL DEFAULT 'in_stock'
                        CHECK (status IN ('in_stock', 'approved_for_disposal', 'disposed')),
  received_date       date NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  -- Position within its receipt (1 = first unit submitted), so a retried confirmation (same
  -- idempotency key) returns the same clientRowId → storage unit mapping (TRP-T09). Every receipt
  -- confirmation sets it.
  receipt_line        integer CHECK (receipt_line BETWEEN 1 AND 50),
  source_type         text
                        CONSTRAINT storage_unit_source_type_check
                        CHECK (source_type IN ('test_hole', 'standalone_location')),
  source_test_hole_id uuid,
  source_location_reference text
                        CONSTRAINT storage_unit_source_location_reference_check
                        CHECK (source_location_reference = btrim(source_location_reference)
                               AND length(source_location_reference) BETWEEN 1 AND 100
                               AND source_location_reference !~ '[[:cntrl:]]'),
  sample_reference    text
                        CONSTRAINT storage_unit_sample_reference_check
                        CHECK (sample_reference = btrim(sample_reference)
                               AND length(sample_reference) BETWEEN 1 AND 40
                               AND sample_reference !~ '[[:cntrl:]]'),
  sample_depth_from   numeric(8, 2),
  sample_depth_to     numeric(8, 2),
  sample_depth_unit   text
                        CONSTRAINT storage_unit_sample_depth_unit_check CHECK (sample_depth_unit IN ('ft', 'm')),
  bulk_group_id       uuid,
  -- Who and when, whichever route disposed the unit (MM-T30).
  disposed_at         timestamptz,
  disposed_by_user_id uuid REFERENCES app_user (id),
  CONSTRAINT storage_unit_project_id_key UNIQUE (project_id, id),
  CONSTRAINT storage_unit_receipt_line_key UNIQUE (receipt_id, receipt_line),
  -- The readable ID must agree with its stored prefix and year.
  CONSTRAINT storage_unit_readable_id_parts_check
    CHECK (readable_id LIKE id_prefix || '-' || issued_year::text || '-%'),
  -- Prefix follows the physical holder at issuance.
  CONSTRAINT storage_unit_prefix_matches_holder_check CHECK (
    (issued_holder_kind = 'bucket' AND id_prefix = 'BKT')
    OR (issued_holder_kind = 'shelby_tube' AND id_prefix = 'ST')
    OR (issued_holder_kind = 'core_box' AND id_prefix = 'CRE')
    OR (issued_holder_kind = 'generic' AND id_prefix = 'CT')
  ),
  -- Current unit type and holder must be consistent; bulk material sits in a bucket or package.
  CONSTRAINT storage_unit_type_matches_holder_check CHECK (
    (unit_type = 'bucket' AND holder_kind = 'bucket')
    OR (unit_type = 'shelby_tube' AND holder_kind = 'shelby_tube')
    OR (unit_type = 'bulk_container' AND holder_kind IN ('bucket', 'generic'))
  ),
  -- The source hole and the group both belong to the unit's project.
  CONSTRAINT storage_unit_source_test_hole_fk FOREIGN KEY (project_id, source_test_hole_id)
    REFERENCES test_hole (project_id, id),
  CONSTRAINT storage_unit_bulk_group_fk FOREIGN KEY (project_id, bulk_group_id)
    REFERENCES bulk_group (project_id, id),
  -- Exactly one source kind, with its matching reference, and no sample identity without one.
  CONSTRAINT storage_unit_source_shape_check CHECK (
    CASE source_type
      WHEN 'test_hole' THEN
        source_test_hole_id IS NOT NULL AND source_location_reference IS NULL
      WHEN 'standalone_location' THEN
        source_test_hole_id IS NULL AND source_location_reference IS NOT NULL
      ELSE
        source_test_hole_id IS NULL AND source_location_reference IS NULL
        AND sample_reference IS NULL AND sample_depth_from IS NULL
    END
  ),
  -- Depth is optional for a tube, but a depth always has a unit and an interval never runs backwards.
  CONSTRAINT storage_unit_sample_depth_check CHECK (
    (sample_depth_from IS NULL AND sample_depth_to IS NULL AND sample_depth_unit IS NULL)
    OR (sample_depth_from IS NOT NULL AND sample_depth_from >= 0 AND sample_depth_unit IS NOT NULL
        AND (sample_depth_to IS NULL OR sample_depth_to >= sample_depth_from))
  ),
  -- Which units carry what:
  --   ordinary bucket: hole summaries only (no source, no group);
  --   Shelby tube: its own source (it may have none until a correction adds one), never a group;
  --   bulk soil bucket: holder bucket, exactly one group, no own source;
  --   generic CT bulk container (separate generic-container rules): neither.
  CONSTRAINT storage_unit_contents_by_type_check CHECK (
    (unit_type = 'bucket' AND source_type IS NULL AND bulk_group_id IS NULL)
    OR (unit_type = 'shelby_tube' AND bulk_group_id IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'bucket'
        AND bulk_group_id IS NOT NULL AND source_type IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'generic'
        AND bulk_group_id IS NULL AND source_type IS NULL)
  )
);
CREATE INDEX storage_unit_project_status_idx ON storage_unit (project_id, status);
CREATE INDEX storage_unit_location_idx ON storage_unit (current_location_id, status);
CREATE INDEX storage_unit_receipt_idx ON storage_unit (receipt_id);
CREATE INDEX storage_unit_received_date_idx ON storage_unit (received_date);
-- Sorting: received date or ID, with the ID as the tie-breaker so pages never overlap or skip.
-- "C" collation compares the ID byte by byte (BKT-2026-000014 before BKT-2026-000015) whatever the
-- database's locale (TRP-T12).
CREATE INDEX storage_unit_received_id_idx
  ON storage_unit (received_date, readable_id COLLATE "C");
CREATE INDEX storage_unit_readable_id_c_idx ON storage_unit (readable_id COLLATE "C");
CREATE INDEX storage_unit_bulk_group_idx
  ON storage_unit (bulk_group_id, received_date, readable_id COLLATE "C")
  WHERE bulk_group_id IS NOT NULL;
CREATE INDEX storage_unit_source_test_hole_idx
  ON storage_unit (source_test_hole_id) WHERE source_test_hole_id IS NOT NULL;

-- Issued identity is permanent: reject any UPDATE that changes it.
CREATE FUNCTION storage_unit_identity_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.readable_id IS DISTINCT FROM OLD.readable_id
     OR NEW.id_prefix IS DISTINCT FROM OLD.id_prefix
     OR NEW.issued_year IS DISTINCT FROM OLD.issued_year
     OR NEW.issued_holder_kind IS DISTINCT FROM OLD.issued_holder_kind THEN
    RAISE EXCEPTION 'storage unit % identity is immutable', OLD.readable_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_identity_immutable
  BEFORE UPDATE ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_identity_is_immutable();

-- An issued storage unit ID can never be reused (MM-T47, CLAUDE.md "Never" rule). Enforced by
-- triggers (not only grants) because the table owner bypasses grants.
-- * storage_unit rows can't be deleted or truncated: the row is the record that its readable_id was
--   issued, and the UNIQUE constraint on readable_id only blocks a reissue while the row exists.
--   Units leave the lab through status (approved_for_disposal / disposed), never by deletion.
-- * storage_unit_annual_counter rows can't be deleted or truncated, and last_value can never go
--   down: either would let the allocator hand out a number that was already issued. Raising a
--   counter stays allowed (needed after a restore).
-- Receipts need no trigger: storage_unit.receipt_id (no ON DELETE action) already refuses
-- deleting a receipt that issued units. Hole summaries carry no ID and are replaced by corrections.
-- Test and dev resets drop and recreate the schema, so they are unaffected.
CREATE FUNCTION storage_unit_id_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    RAISE EXCEPTION 'storage unit % can''t be deleted: issued storage unit IDs are permanent',
      OLD.readable_id
      USING ERRCODE = 'restrict_violation',
            HINT = 'Record disposal through the unit status instead.';
  END IF;
  RAISE EXCEPTION '% on storage_unit is not allowed: issued storage unit IDs are permanent', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER storage_unit_no_delete
  BEFORE DELETE ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_id_is_permanent();

CREATE TRIGGER storage_unit_no_truncate
  BEFORE TRUNCATE ON storage_unit
  FOR EACH STATEMENT EXECUTE FUNCTION storage_unit_id_is_permanent();

CREATE FUNCTION storage_unit_counter_never_goes_back() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prefix IS DISTINCT FROM OLD.prefix OR NEW.year IS DISTINCT FROM OLD.year THEN
      RAISE EXCEPTION 'storage unit counter %-% can''t be moved to another prefix or year',
        OLD.prefix, OLD.year
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.last_value < OLD.last_value THEN
      RAISE EXCEPTION 'storage unit counter %-% can''t go down from % to %: issued IDs are never reused',
        OLD.prefix, OLD.year, OLD.last_value, NEW.last_value
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_LEVEL = 'ROW' THEN
    RAISE EXCEPTION 'storage unit counter %-% can''t be deleted: issued IDs are never reused',
      OLD.prefix, OLD.year
      USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION '% on storage_unit_annual_counter is not allowed: issued IDs are never reused',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER storage_unit_annual_counter_no_decrease
  BEFORE UPDATE OR DELETE ON storage_unit_annual_counter
  FOR EACH ROW EXECUTE FUNCTION storage_unit_counter_never_goes_back();

CREATE TRIGGER storage_unit_annual_counter_no_truncate
  BEFORE TRUNCATE ON storage_unit_annual_counter
  FOR EACH STATEMENT EXECUTE FUNCTION storage_unit_counter_never_goes_back();

-- Units are only ever placed in an active location. Locking the destination row makes this wait
-- for a retirement in progress (which holds FOR UPDATE) and then see its result; a retirement
-- that starts second waits for this transaction and then counts the unit as an occupant.
CREATE FUNCTION storage_unit_location_must_be_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  destination_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_location_id IS NOT DISTINCT FROM OLD.current_location_id THEN
    RETURN NEW;
  END IF;
  SELECT active INTO destination_active
  FROM location WHERE id = NEW.current_location_id
  FOR KEY SHARE;
  IF destination_active IS FALSE THEN
    RAISE EXCEPTION 'location is retired; storage units can''t be placed there'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_location_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_location_active
  BEFORE INSERT OR UPDATE OF current_location_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_location_must_be_active();

CREATE TABLE storage_unit_hole_summary (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id  uuid NOT NULL,
  project_id       uuid NOT NULL,
  test_hole_id     uuid NOT NULL,
  summary_type     text NOT NULL
                     CHECK (summary_type IN ('all', 'sample_range', 'depth_range', 'custom')),
  sample_from      text CHECK (length(sample_from) BETWEEN 1 AND 20),
  sample_to        text CHECK (length(sample_to) BETWEEN 1 AND 20),
  depth_from       numeric(8, 2),
  depth_to         numeric(8, 2),
  depth_unit       text CHECK (depth_unit IN ('ft', 'm')),
  custom_text      text CHECK (length(custom_text) <= 500),
  note             text CHECK (length(note) <= 500),
  -- Both FKs carry project_id, so the unit and the hole must belong to the same project (D12).
  CONSTRAINT summary_storage_unit_fk FOREIGN KEY (project_id, storage_unit_id)
    REFERENCES storage_unit (project_id, id),
  CONSTRAINT summary_test_hole_fk FOREIGN KEY (project_id, test_hole_id)
    REFERENCES test_hole (project_id, id),
  CONSTRAINT summary_one_per_hole_key UNIQUE (storage_unit_id, test_hole_id),
  CONSTRAINT summary_shape_check CHECK (
    CASE summary_type
      WHEN 'all' THEN
        sample_from IS NULL AND sample_to IS NULL
        AND depth_from IS NULL AND depth_to IS NULL AND depth_unit IS NULL
        AND custom_text IS NULL
      WHEN 'sample_range' THEN
        sample_from IS NOT NULL AND sample_to IS NOT NULL
        AND depth_from IS NULL AND depth_to IS NULL AND depth_unit IS NULL
        AND custom_text IS NULL
      WHEN 'depth_range' THEN
        depth_from IS NOT NULL AND depth_to IS NOT NULL AND depth_unit IS NOT NULL
        AND depth_from >= 0 AND depth_to >= depth_from
        AND sample_from IS NULL AND sample_to IS NULL AND custom_text IS NULL
      WHEN 'custom' THEN
        custom_text IS NOT NULL AND length(btrim(custom_text)) > 0
        AND sample_from IS NULL AND sample_to IS NULL
        AND depth_from IS NULL AND depth_to IS NULL AND depth_unit IS NULL
    END
  )
);
CREATE INDEX summary_test_hole_idx ON storage_unit_hole_summary (test_hole_id);

-- One contents summary per unit: a unit with its own sample identity or a bulk group never also
-- has hole summaries (a bulk soil bucket always has a group, see the check above). Checked from
-- both sides so neither insert order can get round it.
CREATE FUNCTION storage_unit_summary_allowed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_identity boolean;
BEGIN
  SELECT source_type IS NOT NULL OR bulk_group_id IS NOT NULL INTO has_identity
  FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF has_identity THEN
    RAISE EXCEPTION 'storage unit % has a sample identity; it can''t also have hole summaries',
      NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_one_contents_summary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_hole_summary_allowed
  BEFORE INSERT OR UPDATE OF storage_unit_id ON storage_unit_hole_summary
  FOR EACH ROW EXECUTE FUNCTION storage_unit_summary_allowed();

CREATE FUNCTION storage_unit_identity_excludes_summaries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source_type IS NOT NULL OR NEW.bulk_group_id IS NOT NULL)
     AND EXISTS (SELECT 1 FROM storage_unit_hole_summary WHERE storage_unit_id = NEW.id) THEN
    RAISE EXCEPTION 'storage unit % has hole summaries; remove them before giving it a sample identity',
      NEW.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_one_contents_summary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_identity_excludes_summaries
  BEFORE UPDATE OF source_type, bulk_group_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_identity_excludes_summaries();

-- The names the sticker's existing origin line prints (test-hole / field-location names, App
-- Idea §5): the bulk group's source, the tube's own source, or the hole summaries' hole names.
-- Shared by the label preview and the print worker so they can't drift apart. Never sample
-- references, depths, summaries, group IDs or bucket counts.
CREATE FUNCTION storage_unit_origin_names(unit_id uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN su.bulk_group_id IS NOT NULL THEN
      ARRAY(SELECT coalesce(th.name, g.source_location_reference)
            FROM bulk_group g LEFT JOIN test_hole th ON th.id = g.test_hole_id
            WHERE g.id = su.bulk_group_id)
    WHEN su.source_type IS NOT NULL THEN
      ARRAY[coalesce((SELECT th.name FROM test_hole th WHERE th.id = su.source_test_hole_id),
                     su.source_location_reference)]
    ELSE
      ARRAY(SELECT th.name
            FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id
            WHERE h.storage_unit_id = su.id
            ORDER BY th.name_normalized)
  END
  FROM storage_unit su
  WHERE su.id = unit_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit (TRP-T03, MM-T56)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_event (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  action                   text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type              text NOT NULL,
  entity_id                uuid,
  actor_user_id            uuid REFERENCES app_user (id),
  actor_account_type       text CHECK (actor_account_type IN ('personal', 'shared_lab', 'test', 'system')),
  actor_initials_snapshot  text,
  actor_name_snapshot      text,
  receiver_user_id         uuid REFERENCES app_user (id),
  reason                   text CHECK (length(reason) <= 2000),
  before_values            jsonb,
  after_values             jsonb,
  request_id               text,
  -- An event that credits a receiver keeps the receiver's initials and name as they were when it
  -- happened, like the actor and the receipt do (MM-T56). Initials may be NULL: a print at a LAB
  -- station or a project can credit staff who have no confirmed initials yet. The name is always
  -- there.
  receiver_initials_snapshot text
    CONSTRAINT audit_event_receiver_initials_snapshot_check
    CHECK (receiver_initials_snapshot ~ '^[A-Z]{1,5}$'),
  receiver_name_snapshot   text
    CONSTRAINT audit_event_receiver_name_snapshot_check
    CHECK (length(btrim(receiver_name_snapshot)) BETWEEN 1 AND 200),
  CONSTRAINT audit_event_receiver_snapshot_required CHECK (
    CASE
      WHEN receiver_user_id IS NULL
        THEN receiver_initials_snapshot IS NULL AND receiver_name_snapshot IS NULL
      ELSE receiver_name_snapshot IS NOT NULL
    END
  )
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_event_action_idx ON audit_event (action, occurred_at DESC);

-- Audit events are append-only. A trigger (not only grants) enforces this, because the table owner
-- bypasses grants. Fixing a mistaken event means recording a new, correcting event.
CREATE FUNCTION audit_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_is_append_only();

-- Belt and braces for non-owner roles (the production API role, TRP-T20).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Label printing (TRP-T15, MM-T37, MM-T65)
-- ---------------------------------------------------------------------------------------------
--
-- Persistent Zebra print queue. Printers are server-side configuration: clients only ever name a
-- printer by its key, never a host or port. Jobs keep honest status: a job is only `sent` when
-- every byte was written and the connection closed cleanly; anything ambiguous is `uncertain` and
-- is never resent automatically. A job names its target type: storage-unit jobs list their units
-- in print_job_item; location jobs list their labels in print_job_location_item with the code and
-- name as they were requested. No fake storage unit or receipt ever stands in for a location.

CREATE TABLE printer (
  key           text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- IPv4 address or DNS host name; never accepted from a print request.
  host          text NOT NULL CHECK (host ~ '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'),
  port          integer NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
  enabled       boolean NOT NULL DEFAULT true,
  -- Used when a print request names no printer. At most one.
  is_default    boolean NOT NULL DEFAULT false,
  -- Ask the printer for its host status (~HS) before sending labels.
  check_status  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX printer_one_default_idx ON printer (is_default) WHERE is_default;

-- A print job keeps the people on it as they were at the time, like audit events and receipts:
-- the receiver it credits (a print at a LAB station) and the requester as of the request, and
-- whoever confirmed the labels came out as of the confirmation (MM-T65; Kyle, 2026-10-27). Initials
-- may be NULL: the shared LAB account and staff without confirmed initials are recorded by name.
CREATE TABLE print_job (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text NOT NULL CHECK (kind IN ('initial', 'reprint')),
  printer_key             text NOT NULL,
  template_version        text NOT NULL,
  requested_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  receiver_user_id        uuid REFERENCES app_user (id),
  status                  text NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'uncertain')),
  attempts                integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error              text,
  physically_confirmed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Earliest time the worker may (re)try a queued job (retry backoff after a safe failure).
  next_attempt_at         timestamptz NOT NULL DEFAULT now(),
  -- Plain-language printer condition from host status, e.g. "Printer out of labels".
  printer_message         text CHECK (length(printer_message) <= 200),
  sent_at                 timestamptz,
  physically_confirmed_by_user_id uuid REFERENCES app_user (id),
  requested_by_initials_snapshot text
    CONSTRAINT print_job_requested_by_initials_snapshot_check
    CHECK (requested_by_initials_snapshot ~ '^[A-Z]{1,5}$'),
  requested_by_name_snapshot text
    CONSTRAINT print_job_requested_by_name_snapshot_check
    CHECK (length(btrim(requested_by_name_snapshot)) BETWEEN 1 AND 200),
  receiver_initials_snapshot text
    CONSTRAINT print_job_receiver_initials_snapshot_check
    CHECK (receiver_initials_snapshot ~ '^[A-Z]{1,5}$'),
  receiver_name_snapshot  text
    CONSTRAINT print_job_receiver_name_snapshot_check
    CHECK (length(btrim(receiver_name_snapshot)) BETWEEN 1 AND 200),
  confirmed_by_initials_snapshot text
    CONSTRAINT print_job_confirmed_by_initials_snapshot_check
    CHECK (confirmed_by_initials_snapshot ~ '^[A-Z]{1,5}$'),
  confirmed_by_name_snapshot text
    CONSTRAINT print_job_confirmed_by_name_snapshot_check
    CHECK (length(btrim(confirmed_by_name_snapshot)) BETWEEN 1 AND 200),
  target_type             text NOT NULL DEFAULT 'storage_unit'
    CONSTRAINT print_job_target_type_check CHECK (target_type IN ('storage_unit', 'location')),
  CONSTRAINT print_job_printer_fk FOREIGN KEY (printer_key) REFERENCES printer (key),
  CONSTRAINT print_job_last_error_length_check CHECK (length(last_error) <= 500),
  -- Retries stop at three attempts.
  CONSTRAINT print_job_attempts_max_check CHECK (attempts <= 3),
  CONSTRAINT print_job_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  -- A person can only confirm labels came out for a job that sent (or may have sent) bytes.
  CONSTRAINT print_job_physical_confirmation_check CHECK (
    (physically_confirmed_at IS NULL AND physically_confirmed_by_user_id IS NULL)
    OR (physically_confirmed_at IS NOT NULL AND physically_confirmed_by_user_id IS NOT NULL
        AND status IN ('sent', 'uncertain'))
  ),
  -- Snapshots only with the person, and initials only with a name.
  CONSTRAINT print_job_people_snapshot_pairing_check CHECK (
    (requested_by_name_snapshot IS NOT NULL OR requested_by_initials_snapshot IS NULL)
    AND (receiver_user_id IS NOT NULL OR receiver_name_snapshot IS NULL)
    AND (receiver_name_snapshot IS NOT NULL OR receiver_initials_snapshot IS NULL)
    AND (physically_confirmed_by_user_id IS NOT NULL OR confirmed_by_name_snapshot IS NULL)
    AND (confirmed_by_name_snapshot IS NOT NULL OR confirmed_by_initials_snapshot IS NULL)
  )
);
CREATE INDEX print_job_queue_idx ON print_job (printer_key, status, created_at);
CREATE INDEX print_job_status_idx ON print_job (status) WHERE status IN ('queued', 'sending');

-- A new job, a new or changed receiver, or a new confirmation must carry the person's name
-- snapshot, and a snapshot is never cleared. (Kept as a trigger, as the lineage had it, so the
-- rule reads the same whether a job is inserted or updated.)
CREATE FUNCTION print_job_people_snapshots_required() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requested_by_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR OLD.requested_by_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % has no requester name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.receiver_user_id IS NOT NULL AND NEW.receiver_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.receiver_user_id IS DISTINCT FROM OLD.receiver_user_id
    OR OLD.receiver_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % credits a receiver without a name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.physically_confirmed_by_user_id IS NOT NULL AND NEW.confirmed_by_name_snapshot IS NULL AND (
    TG_OP = 'INSERT'
    OR NEW.physically_confirmed_by_user_id IS DISTINCT FROM OLD.physically_confirmed_by_user_id
    OR OLD.confirmed_by_name_snapshot IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'print job % is confirmed without the confirmer name snapshot', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_people_snapshots_required
  BEFORE INSERT OR UPDATE ON print_job
  FOR EACH ROW EXECUTE FUNCTION print_job_people_snapshots_required();

CREATE FUNCTION print_job_target_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'print job % target type can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_target_immutable
  BEFORE UPDATE OF target_type ON print_job
  FOR EACH ROW EXECUTE FUNCTION print_job_target_is_immutable();

CREATE TABLE print_job_item (
  print_job_id     uuid NOT NULL REFERENCES print_job (id),
  storage_unit_id  uuid NOT NULL REFERENCES storage_unit (id),
  position         integer NOT NULL CHECK (position >= 1),
  PRIMARY KEY (print_job_id, storage_unit_id),
  UNIQUE (print_job_id, position)
);
CREATE INDEX print_job_item_unit_idx ON print_job_item (storage_unit_id);

CREATE TABLE print_job_location_item (
  print_job_id   uuid NOT NULL REFERENCES print_job (id),
  location_id    uuid NOT NULL REFERENCES location (id),
  position       integer NOT NULL CHECK (position >= 1),
  -- What the label carries, as requested: the payload is 'LOC-' || code_snapshot. The code is
  -- locked from the request on, so it always equals the location's code; the name may be renamed
  -- later and history keeps the name that was printed.
  code_snapshot  text NOT NULL CHECK (code_snapshot ~ '^[A-Z0-9-]{2,20}$'),
  name_snapshot  text NOT NULL CHECK (length(btrim(name_snapshot)) BETWEEN 1 AND 100),
  PRIMARY KEY (print_job_id, location_id),
  UNIQUE (print_job_id, position)
);
CREATE INDEX print_job_location_item_location_idx ON print_job_location_item (location_id);

-- Items must match their job's target type, a location label must carry the location's own
-- (locked) code, and a job's target type never changes.
CREATE FUNCTION print_job_item_matches_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  job_target text;
  location_code text;
  location_locked timestamptz;
BEGIN
  SELECT target_type INTO job_target FROM print_job WHERE id = NEW.print_job_id;
  IF TG_TABLE_NAME = 'print_job_item' THEN
    IF job_target IS DISTINCT FROM 'storage_unit' THEN
      RAISE EXCEPTION 'print job % is not a storage-unit job', NEW.print_job_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF job_target IS DISTINCT FROM 'location' THEN
    RAISE EXCEPTION 'print job % is not a location job', NEW.print_job_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT code_normalized, code_locked_at INTO location_code, location_locked
  FROM location WHERE id = NEW.location_id;
  IF location_locked IS NULL OR location_code IS DISTINCT FROM NEW.code_snapshot THEN
    RAISE EXCEPTION 'location label must carry the location''s locked code'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_item_target
  BEFORE INSERT OR UPDATE ON print_job_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_matches_target();

CREATE TRIGGER print_job_location_item_target
  BEFORE INSERT OR UPDATE ON print_job_location_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_matches_target();

-- ---------------------------------------------------------------------------------------------
-- Inventory search (TRP-T12, MM-T59, MM-T36)
-- ---------------------------------------------------------------------------------------------
--
-- Search matches every word somewhere in a storage unit's searchable text: its ID, type and note,
-- project number / name / client, each test-hole name with its SAMPLE#/DEPTH summary (including
-- Custom text and summary notes), the saved location, and a Shelby tube's or bulk bucket's sample
-- identity. Gathering that text needs several joins, so a trigger-maintained document per unit
-- (storage_unit_search) keeps it in one lower-cased column with a trigram index, and each search
-- word becomes `document LIKE '%word%'`. Triggers refresh the document whenever any source value
-- changes, inside the same transaction.

CREATE TABLE storage_unit_search (
  storage_unit_id uuid PRIMARY KEY REFERENCES storage_unit (id),
  -- Lower-cased, newline-separated searchable values. Never shown to users.
  document        text NOT NULL
);
CREATE INDEX storage_unit_search_document_trgm_idx
  ON storage_unit_search USING gin (document public.gin_trgm_ops);

-- The searchable text of one unit, built from current values. Fields are separated by newlines so
-- a word never matches across two fields (search words never contain whitespace). Besides the raw
-- values the document holds the forms the app displays:
--   * sample ranges "g1 s10" and "g1-s10"; depth ranges "3 5 ft" and "3-5 ft" (MM-T59);
--   * each hole as displayed, "<test hole>: <summary>" ("th26-01: g1-s10") (MM-T59);
--   * a Shelby tube's own identity or a bulk bucket's group identity: "bulk soil sample" for bulk
--     buckets, the source name, sample reference, depth as separate ends ("1.5 2 m") and joined
--     ("1.5-2 m"), the group description, and the identity as formatSampleIdentity displays it,
--     e.g. "th26-21: b1 at 1.5-2 m" (MM-T36).
-- Every dash in the document folds to "-": hyphens U+2010/U+2011, figure/en/em dashes and the
-- horizontal bar U+2012–U+2015, the minus sign U+2212, and the small and full-width hyphens
-- U+FE58/U+FE63/U+FF0D. splitInventorySearch (packages/shared/src/inventory.ts) folds search words
-- with exactly the same set, so "G1–S10", "G1-S10" and "G1−S10" all match.
CREATE FUNCTION storage_unit_search_document(unit_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH identity AS (
    SELECT su.id,
           coalesce(sth.name, g.source_location_reference, su.source_location_reference)
             AS source_name,
           CASE WHEN g.id IS NOT NULL THEN g.sample_reference ELSE su.sample_reference END
             AS sample_reference,
           CASE WHEN g.id IS NOT NULL THEN g.depth_from ELSE su.sample_depth_from END AS depth_from,
           CASE WHEN g.id IS NOT NULL THEN g.depth_to ELSE su.sample_depth_to END AS depth_to,
           CASE WHEN g.id IS NOT NULL THEN g.depth_unit ELSE su.sample_depth_unit END AS depth_unit,
           g.id IS NOT NULL AS bulk,
           g.description
    FROM storage_unit su
    LEFT JOIN bulk_group g ON g.id = su.bulk_group_id
    LEFT JOIN test_hole sth
      ON sth.id = CASE WHEN g.id IS NOT NULL THEN g.test_hole_id ELSE su.source_test_hole_id END
    WHERE su.id = unit_id
  ), depth AS (
    SELECT id,
           CASE
             WHEN depth_from IS NULL THEN NULL
             WHEN depth_to IS NULL THEN trim_scale(depth_from)::text || ' ' || depth_unit
             ELSE trim_scale(depth_from)::text || '-' || trim_scale(depth_to)::text || ' '
                  || depth_unit
           END AS joined,
           CASE
             WHEN depth_to IS NULL THEN NULL
             ELSE trim_scale(depth_from)::text || ' ' || trim_scale(depth_to)::text || ' '
                  || depth_unit
           END AS ends
    FROM identity
  )
  SELECT translate(
    lower(concat_ws(E'\n',
      su.readable_id,
      replace(su.unit_type, '_', ' '),
      su.note,
      p.project_number,
      p.name,
      p.client,
      l.code,
      l.name,
      (SELECT string_agg(concat_ws(E'\n',
                th.name,
                CASE h.summary_type
                  WHEN 'all' THEN 'all'
                  WHEN 'sample_range' THEN h.sample_from || ' ' || h.sample_to || ' '
                                           || h.sample_from || '-' || h.sample_to
                  WHEN 'depth_range' THEN trim_scale(h.depth_from)::text || ' '
                                          || trim_scale(h.depth_to)::text || ' ' || h.depth_unit
                                          || E'\n' || trim_scale(h.depth_from)::text || '-'
                                          || trim_scale(h.depth_to)::text || ' ' || h.depth_unit
                END,
                -- As formatStorageUnitHoleSummary shows it after the test-hole name.
                th.name || ': ' || CASE h.summary_type
                  WHEN 'all' THEN 'all'
                  WHEN 'sample_range' THEN concat(h.sample_from, '-', h.sample_to)
                  WHEN 'depth_range' THEN trim(concat(trim_scale(h.depth_from)::text, '-',
                                               trim_scale(h.depth_to)::text, ' ', h.depth_unit))
                  WHEN 'custom' THEN coalesce(h.custom_text, '')
                END,
                h.custom_text,
                h.note), E'\n' ORDER BY th.name_normalized)
       FROM storage_unit_hole_summary h
       JOIN test_hole th ON th.id = h.test_hole_id
       WHERE h.storage_unit_id = su.id),
      -- MM-T36: sample identity of a Shelby tube or bulk soil bucket.
      CASE WHEN i.bulk THEN 'bulk soil sample' END,
      i.source_name,
      i.sample_reference,
      d.ends,
      d.joined,
      i.description,
      -- As formatSampleIdentity shows it: "<source>: <reference> at <depth>".
      CASE WHEN i.source_name IS NOT NULL THEN
        i.source_name
        || CASE WHEN i.sample_reference IS NOT NULL OR d.joined IS NOT NULL THEN ': ' ELSE '' END
        || coalesce(i.sample_reference, '')
        || CASE WHEN i.sample_reference IS NOT NULL AND d.joined IS NOT NULL THEN ' at ' ELSE '' END
        || coalesce(d.joined, '')
      END)),
    U&'\2010\2011\2012\2013\2014\2015\2212\FE58\FE63\FF0D',
    '----------')
  FROM storage_unit su
  JOIN project p ON p.id = su.project_id
  JOIN location l ON l.id = su.current_location_id
  JOIN identity i ON i.id = su.id
  JOIN depth d ON d.id = su.id
  WHERE su.id = unit_id
$$;

CREATE FUNCTION refresh_storage_unit_search(unit_ids uuid[]) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO storage_unit_search (storage_unit_id, document)
  SELECT su.id, storage_unit_search_document(su.id)
  FROM storage_unit su
  WHERE su.id = ANY (unit_ids)
  ON CONFLICT (storage_unit_id) DO UPDATE SET document = EXCLUDED.document
$$;

CREATE FUNCTION storage_unit_search_on_unit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_unit
  AFTER INSERT OR UPDATE OF readable_id, unit_type, note, project_id, current_location_id,
    source_type, source_test_hole_id, source_location_reference, sample_reference,
    sample_depth_from, sample_depth_to, sample_depth_unit, bulk_group_id
  ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_unit();

CREATE FUNCTION storage_unit_search_on_summary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_storage_unit_search(ARRAY[OLD.storage_unit_id]);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_storage_unit_search(ARRAY[NEW.storage_unit_id]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_summary
  AFTER INSERT OR UPDATE OR DELETE ON storage_unit_hole_summary
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_summary();

CREATE FUNCTION storage_unit_search_on_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY(SELECT id FROM storage_unit WHERE project_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_project
  AFTER UPDATE OF project_number, name, client ON project
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_project();

-- A renamed hole refreshes units that summarise it, tubes sourced from it and bulk buckets whose
-- group is sourced from it.
CREATE FUNCTION storage_unit_search_on_test_hole() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY(
    SELECT storage_unit_id FROM storage_unit_hole_summary WHERE test_hole_id = NEW.id
    UNION
    SELECT id FROM storage_unit WHERE source_test_hole_id = NEW.id
    UNION
    SELECT su.id FROM storage_unit su JOIN bulk_group g ON g.id = su.bulk_group_id
    WHERE g.test_hole_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_test_hole
  AFTER UPDATE OF name ON test_hole
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_test_hole();

CREATE FUNCTION storage_unit_search_on_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY(
    SELECT id FROM storage_unit WHERE current_location_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_location
  AFTER UPDATE OF code, name ON location
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_location();

-- A corrected group identity refreshes every member bucket in the same transaction.
CREATE FUNCTION storage_unit_search_on_bulk_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY(
    SELECT id FROM storage_unit WHERE bulk_group_id = NEW.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER storage_unit_search_bulk_group
  AFTER UPDATE OF source_type, test_hole_id, source_location_reference, sample_reference,
    depth_from, depth_to, depth_unit, description
  ON bulk_group
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_bulk_group();

-- ---------------------------------------------------------------------------------------------
-- Draft auto-delete setting (MM-T45)
-- ---------------------------------------------------------------------------------------------
--
-- Receiving drafts live only in each browser (TRP-T11). This one-row table says whether browsers
-- delete their own drafts that haven't been saved for `after_days` days. Off by default; Admin and
-- Lab Manager change it through PUT /api/settings/drafts (optimistic `version`, audited as
-- settings.drafts_changed). The browser does the deleting; the server never sees drafts.

CREATE TABLE draft_auto_delete_setting (
  -- Exactly one row: the primary key can only be true.
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled             boolean NOT NULL DEFAULT false,
  after_days          integer NOT NULL DEFAULT 90 CHECK (after_days BETWEEN 30 AND 365),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES app_user (id)
);

INSERT INTO draft_auto_delete_setting DEFAULT VALUES;

-- ---------------------------------------------------------------------------------------------
-- Destination scans, queued moves and location conflicts (MM-T28)
-- ---------------------------------------------------------------------------------------------
--
-- Three tables, all append-or-settle (never deleted):
-- * movement_event: every move attempt the server accepted, whether it changed the saved location
--   ('move'), was held because the unit had changed since the scan ('contested') or was a person
--   confirming the actual location to settle a conflict ('resolution'). Scan time is what the
--   device reported; saved_at is the server's clock. Device time never decides anything.
-- * location_conflict: a unit whose actual location needs a person to confirm it. At most one is
--   open per unit; later contested attempts join it (its version goes up) until it is resolved.
-- * move_action: the durable idempotency record of each client move intent (client_move_id, a
--   UUID the browser generates once per scan). It stores the outcome so a retry after a lost
--   response gets the original answer, and the account so no other account can adopt or read it.
--
-- Lock order (documented in docs/database.md): storage_unit FOR UPDATE, then the destination
-- location FOR KEY SHARE (storage_unit_location_active does the same), then location_conflict
-- FOR UPDATE.
-- Corrections lock the unit first too, and location retirement locks only the location, so a
-- move and a retirement serialise on the location row without deadlocking.

CREATE TABLE location_conflict (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- Bumped whenever an attempt joins or the conflict is resolved; resolve requests send it.
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  -- The unit's saved location and version when the conflict opened.
  saved_location_id           uuid NOT NULL REFERENCES location (id),
  saved_version               integer NOT NULL CHECK (saved_version >= 1),
  resolved_at                 timestamptz,
  resolved_by_user_id         uuid REFERENCES app_user (id),
  resolved_by_initials_snapshot text,
  resolved_by_name_snapshot   text,
  resolved_location_id        uuid REFERENCES location (id),
  resolution_note             text CHECK (length(btrim(resolution_note)) BETWEEN 1 AND 500),
  client_resolution_id        uuid UNIQUE,
  resolution_request_hash     text,
  CONSTRAINT location_conflict_resolution_check CHECK (
    (status = 'open') = (resolved_at IS NULL)
    AND (resolved_at IS NULL) = (resolved_by_user_id IS NULL)
    AND (resolved_at IS NULL) = (resolved_location_id IS NULL)
    AND (resolved_at IS NULL) = (client_resolution_id IS NULL)
    AND (client_resolution_id IS NULL) = (resolution_request_hash IS NULL)
  )
);
CREATE UNIQUE INDEX location_conflict_one_open_idx
  ON location_conflict (storage_unit_id) WHERE status = 'open';
CREATE INDEX location_conflict_unit_idx ON location_conflict (storage_unit_id, opened_at DESC);

CREATE TABLE movement_event (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  kind                        text NOT NULL CHECK (kind IN ('move', 'contested', 'resolution')),
  -- Saved location when the server handled it, and where the scan (or the person) put it.
  from_location_id            uuid NOT NULL REFERENCES location (id),
  to_location_id              uuid NOT NULL REFERENCES location (id),
  -- The version the scan was based on, and the unit's version after this event (null when the
  -- event changed nothing: a contested attempt).
  base_version                integer CHECK (base_version >= 1),
  resulting_version           integer CHECK (resulting_version >= 1),
  -- The signed-in account that saved it (from the session, never from the request).
  actor_user_id               uuid NOT NULL REFERENCES app_user (id),
  actor_account_type          text NOT NULL CHECK (actor_account_type IN ('personal', 'shared_lab', 'test')),
  actor_initials_snapshot     text,
  actor_name_snapshot         text NOT NULL,
  -- Staff member credited at a LAB station, as they were when the move was saved.
  mover_user_id               uuid REFERENCES app_user (id),
  mover_initials_snapshot     text,
  mover_name_snapshot         text,
  -- Reported by the browser: a random per-browser-profile ID (not a session) and its clock.
  station_id                  uuid,
  scanned_at                  timestamptz,
  saved_at                    timestamptz NOT NULL DEFAULT now(),
  source                      text NOT NULL CHECK (source IN ('online', 'queued', 'resolution')),
  client_move_id              uuid UNIQUE,
  conflict_id                 uuid REFERENCES location_conflict (id),
  note                        text CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  CONSTRAINT movement_event_shape_check CHECK (
    CASE kind
      WHEN 'move' THEN client_move_id IS NOT NULL AND resulting_version IS NOT NULL
                       AND base_version IS NOT NULL AND scanned_at IS NOT NULL
                       AND source IN ('online', 'queued')
      WHEN 'contested' THEN client_move_id IS NOT NULL AND resulting_version IS NULL
                            AND base_version IS NOT NULL AND scanned_at IS NOT NULL
                            AND conflict_id IS NOT NULL AND source IN ('online', 'queued')
      WHEN 'resolution' THEN client_move_id IS NULL AND resulting_version IS NOT NULL
                             AND conflict_id IS NOT NULL AND source = 'resolution'
    END
  ),
  CONSTRAINT movement_event_mover_check CHECK (
    (mover_user_id IS NULL) = (mover_name_snapshot IS NULL)
  )
);
CREATE INDEX movement_event_unit_idx ON movement_event (storage_unit_id, saved_at DESC);
CREATE INDEX movement_event_conflict_idx ON movement_event (conflict_id) WHERE conflict_id IS NOT NULL;

CREATE TABLE move_action (
  client_move_id              uuid PRIMARY KEY,
  -- Only this account may replay the action or read its outcome.
  account_user_id             uuid NOT NULL REFERENCES app_user (id),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  station_id                  uuid NOT NULL,
  previous_client_move_id     uuid REFERENCES move_action (client_move_id),
  -- SHA-256 of the validated business intent (no cookies, sessions or retry counters).
  request_hash                text NOT NULL,
  outcome                     text NOT NULL CHECK (outcome IN ('saved', 'conflict')),
  movement_event_id           uuid NOT NULL UNIQUE REFERENCES movement_event (id),
  conflict_id                 uuid REFERENCES location_conflict (id),
  -- Saved: the unit's version after the move. Conflict: its version when the attempt was held.
  resulting_version           integer NOT NULL CHECK (resulting_version >= 1),
  applied_to_location_id      uuid REFERENCES location (id),
  saved_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT move_action_not_self_check CHECK (previous_client_move_id <> client_move_id),
  CONSTRAINT move_action_result_check CHECK (
    (outcome = 'saved' AND conflict_id IS NULL AND applied_to_location_id IS NOT NULL)
    OR (outcome = 'conflict' AND conflict_id IS NOT NULL AND applied_to_location_id IS NULL)
  )
);
CREATE INDEX move_action_unit_idx ON move_action (storage_unit_id);

-- History is append-only: no movement event or recorded action outcome changes or disappears.
-- A conflict changes only from open to resolved (and its version), and only once.
CREATE FUNCTION movement_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER movement_event_append_only
  BEFORE UPDATE OR DELETE ON movement_event
  FOR EACH ROW EXECUTE FUNCTION movement_history_is_append_only();

CREATE TRIGGER move_action_append_only
  BEFORE UPDATE OR DELETE ON move_action
  FOR EACH ROW EXECUTE FUNCTION movement_history_is_append_only();

CREATE FUNCTION location_conflict_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'location conflicts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'location conflict % is resolved and can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.storage_unit_id IS DISTINCT FROM OLD.storage_unit_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.saved_location_id IS DISTINCT FROM OLD.saved_location_id
     OR NEW.saved_version IS DISTINCT FROM OLD.saved_version
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'location conflict % can only gain attempts or be resolved', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_conflict_guard
  BEFORE UPDATE OR DELETE ON location_conflict
  FOR EACH ROW EXECUTE FUNCTION location_conflict_guard();

-- A disposed unit never moves (D28; T36 tested-tube removal, T30 disposal scans). Its last saved
-- location stays as history, so only a change of location is refused.
CREATE FUNCTION storage_unit_disposed_stays_put() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disposed' AND NEW.current_location_id IS DISTINCT FROM OLD.current_location_id THEN
    RAISE EXCEPTION 'storage unit % is disposed and can''t move', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_stays_put';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_stays_put
  BEFORE UPDATE OF current_location_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_stays_put();

-- ---------------------------------------------------------------------------------------------
-- Lab test catalogue (MM-T23)
-- ---------------------------------------------------------------------------------------------
--
-- Groups → optional subgroups → test entries. An entry keeps its exact source code and full
-- description as separate fields, plus an optional concise display name (the description is
-- shown when there is none). No costs are stored anywhere. Entries, templates, groups and
-- subgroups are retired or renamed, never deleted, so every reference stays readable. The two
-- groups the owner named (Soils, Advanced Soils) are reference data (seed/reference.sql), not an
-- enum: Lab Managers may add more.

CREATE TABLE test_group (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_group_name_key UNIQUE (name_normalized)
);

CREATE TABLE test_subgroup (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         uuid NOT NULL REFERENCES test_group (id),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_subgroup_name_key UNIQUE (group_id, name_normalized),
  -- Target of the composite FK that keeps a test's subgroup inside the test's group.
  CONSTRAINT test_subgroup_group_id_key UNIQUE (group_id, id)
);

CREATE TABLE test_type (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES test_group (id),
  subgroup_id  uuid,
  -- Exact source code as supplied (case, punctuation, hyphens and underscores preserved).
  code         text NOT NULL
                 CHECK (code = btrim(code) AND length(code) BETWEEN 1 AND 40
                        AND code !~ '[[:cntrl:]]'),
  -- Optional concise display name; never replaces the description.
  name         text CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120
                           AND name !~ '[[:cntrl:]]'),
  -- Complete detailed description, never truncated.
  description  text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- A code identifies one entry, retired or not: a retired entry is restored, never re-created.
  -- (Revisit only if the workbook reconciliation finds legitimate duplicate codes.)
  CONSTRAINT test_type_code_key UNIQUE (code),
  -- The subgroup, when there is one, belongs to the test's group.
  CONSTRAINT test_type_subgroup_fk FOREIGN KEY (group_id, subgroup_id)
    REFERENCES test_subgroup (group_id, id),
  CONSTRAINT test_type_retired_check CHECK (active = (retired_at IS NULL))
);
CREATE INDEX test_type_group_idx ON test_type (group_id, subgroup_id, sort_order);

CREATE TABLE test_template (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL
                     CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120
                            AND name !~ '[[:cntrl:]]'),
  name_normalized  text GENERATED ALWAYS AS (lower(name)) STORED,
  active           boolean NOT NULL DEFAULT true,
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT test_template_name_key UNIQUE (name_normalized),
  CONSTRAINT test_template_retired_check CHECK (active = (retired_at IS NULL))
);

CREATE TABLE test_template_item (
  template_id   uuid NOT NULL REFERENCES test_template (id) ON DELETE CASCADE,
  test_type_id  uuid NOT NULL REFERENCES test_type (id),
  sort_order    integer NOT NULL DEFAULT 0,
  -- A test appears at most once in a template.
  PRIMARY KEY (template_id, test_type_id)
);

-- Catalogue rows are retired, never deleted (templates' items are replaced by an edit).
CREATE FUNCTION lab_catalogue_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be deleted; retire or rename them instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER test_group_no_delete BEFORE DELETE ON test_group
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_subgroup_no_delete BEFORE DELETE ON test_subgroup
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_type_no_delete BEFORE DELETE ON test_type
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();
CREATE TRIGGER test_template_no_delete BEFORE DELETE ON test_template
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();

-- A subgroup never moves to another group: its tests' composite FK would otherwise dangle.
CREATE FUNCTION test_subgroup_group_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'test subgroup % can''t move to another group', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_subgroup_group_immutable
  BEFORE UPDATE OF group_id ON test_subgroup
  FOR EACH ROW EXECUTE FUNCTION test_subgroup_group_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- Testing programs, lines, coverage and requests (MM-T23, T26)
-- ---------------------------------------------------------------------------------------------
--
-- Program lifecycle: draft → submitted (shown as Open) ⇄ closed. Drafts are workable only by the
-- account that created them (the shared LAB account's drafts by any LAB station); each draft is
-- its own row with its own version, so stations never share a "current draft". Program numbers
-- (LP-YYYY-NNNN) are issued at submission, never for a draft. Closing needs the project's Lead
-- Project Engineer, at least one test request (an empty program is never closable: no vacuous
-- truth) and every request Accepted or Cancelled with a recorded reason. Reopening (Lead Project
-- Engineer or Lab Manager, reason required) changes only the program's status: no test status,
-- acceptance or snapshot changes. Every close and reopen is an append-only program_lifecycle_event;
-- the program row keeps only the current closure. Closure never touches storage units, retention,
-- holds or disposal.
--
-- Testing line: one project-scoped sampling source, chosen explicitly:
--   * test_hole: a hole of the program's project;
--   * standalone_unit: a Shelby tube whose own source is a standalone sampling location;
--   * standalone_bulk_group: a bulk-sample group whose source is a standalone location.
-- Standalone locations are free text on each unit or group (MM-T36, no directory), so equal text
-- never merges two of them into one source: each tube or group is its own source. No placeholder
-- test hole is ever created.
--
-- Scope: all / grabs / spt / specific. Coverage of all/grabs/spt lines is computed when the
-- program is submitted and frozen in program_scope_snapshot, with the matching basis and display
-- snapshots; later receipts or group changes never extend it. Coverage is potential material,
-- never proof that a unit was tested.
--
-- Amendment (D02): an explicit, recorded change to a submitted, open program: new testing lines,
-- new tests on an existing line, or later receipts included in an ALL / Grabs / SPT line from an
-- explicitly reviewed list of units. Every amendment is one append-only program_amendment row
-- listing what it added (including the added units' readable IDs). Rows it adds carry its ID; the
-- coverage frozen at submission is never changed or removed, and a later receipt alone never
-- extends a line.
--
-- Request snapshots: each test request copies the test's code, display name, description, group
-- and subgroup in the submission transaction, so later catalogue edits can't rewrite history.

-- One counter per year for LP-YYYY-NNNN, used only at submission.
CREATE TABLE lab_program_counter (
  year        integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 9999),
  last_value  integer NOT NULL DEFAULT 0 CHECK (last_value BETWEEN 0 AND 9999)
);

CREATE TABLE lab_program (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                       uuid NOT NULL REFERENCES project (id),
  program_number                   text UNIQUE CHECK (program_number ~ '^LP-[0-9]{4}-[0-9]{4}$'),
  status                           text NOT NULL DEFAULT 'draft'
                                     CHECK (status IN ('draft', 'submitted', 'closed')),
  -- D51: Normal unless the project's Lead Project Engineer or a Lab Manager says otherwise (MM-T24).
  priority                         text NOT NULL DEFAULT 'normal'
                                     CHECK (priority IN ('normal', 'urgent')),
  notes                            text CHECK (length(notes) <= 2000),
  -- The authenticated account that created the draft (e.g. LAB) ...
  created_by_account_user_id       uuid NOT NULL REFERENCES app_user (id),
  created_by_account_type          text NOT NULL
                                     CHECK (created_by_account_type IN ('personal', 'shared_lab', 'test')),
  -- ... and the person it is requested by, copied when chosen ("LAB for person").
  requested_by_user_id             uuid NOT NULL REFERENCES app_user (id),
  requested_by_initials_snapshot   text CHECK (length(requested_by_initials_snapshot) BETWEEN 1 AND 5),
  requested_by_name_snapshot       text NOT NULL
                                     CHECK (length(requested_by_name_snapshot) BETWEEN 1 AND 200),
  -- A retried "create draft" returns the draft it made the first time.
  create_idempotency_key           uuid NOT NULL UNIQUE,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  version                          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at                     timestamptz,
  submitted_by_account_user_id     uuid REFERENCES app_user (id),
  submitted_by_account_type        text
                                     CHECK (submitted_by_account_type IN ('personal', 'shared_lab', 'test')),
  submitted_by_initials_snapshot   text,
  submitted_by_name_snapshot       text,
  submitted_for_user_id            uuid REFERENCES app_user (id),
  submitted_for_initials_snapshot  text,
  submitted_for_name_snapshot      text,
  -- A retried submission with the same key returns the original result.
  submit_idempotency_key           uuid UNIQUE,
  -- The current closure (MM-T26); every close and reopen is a program_lifecycle_event.
  closed_at                        timestamptz,
  closed_by_user_id                uuid REFERENCES app_user (id),
  closed_by_initials_snapshot      text,
  closed_by_name_snapshot          text,
  CONSTRAINT lab_program_project_id_key UNIQUE (project_id, id),
  CONSTRAINT lab_program_submission_check CHECK (
    (status = 'draft' AND program_number IS NULL AND submitted_at IS NULL
     AND submitted_by_account_user_id IS NULL AND submit_idempotency_key IS NULL)
    OR (status <> 'draft' AND program_number IS NOT NULL AND submitted_at IS NOT NULL
        AND submitted_by_account_user_id IS NOT NULL AND submitted_by_account_type IS NOT NULL
        AND submitted_by_name_snapshot IS NOT NULL AND submitted_for_user_id IS NOT NULL
        AND submitted_for_name_snapshot IS NOT NULL AND submit_idempotency_key IS NOT NULL)
  ),
  CONSTRAINT lab_program_closed_shape_check CHECK (
    (status = 'closed' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
     AND closed_by_name_snapshot IS NOT NULL)
    OR (status <> 'closed' AND closed_at IS NULL AND closed_by_user_id IS NULL
        AND closed_by_initials_snapshot IS NULL AND closed_by_name_snapshot IS NULL)
  )
);
CREATE INDEX lab_program_project_idx ON lab_program (project_id, status);
CREATE INDEX lab_program_status_idx ON lab_program (status, priority, submitted_at, id);
CREATE INDEX lab_program_draft_owner_idx ON lab_program (created_by_account_user_id)
  WHERE status = 'draft';
-- Worklist: open programs by priority then submission (D52).
CREATE INDEX lab_program_worklist_idx ON lab_program ((priority = 'urgent') DESC, submitted_at, id)
  WHERE status = 'submitted';

CREATE TABLE program_amendment (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id               uuid NOT NULL REFERENCES lab_program (id),
  amendment_number         integer NOT NULL CHECK (amendment_number >= 1),
  reason                   text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  -- What it added, as recorded at the time (lines, tests, units with readable IDs).
  details                  jsonb NOT NULL,
  added_unit_readable_ids  text[] NOT NULL DEFAULT '{}',
  user_id                  uuid NOT NULL REFERENCES app_user (id),
  account_type             text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot        text,
  name_snapshot            text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  idempotency_key          uuid NOT NULL UNIQUE,
  request_hash             text NOT NULL,
  CONSTRAINT program_amendment_number_key UNIQUE (program_id, amendment_number)
);

CREATE TABLE test_line (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                 uuid NOT NULL,
  project_id                 uuid NOT NULL,
  line_number                integer NOT NULL CHECK (line_number BETWEEN 1 AND 200),
  -- The sampling source; null only while the draft is incomplete.
  source_kind                text
                               CHECK (source_kind IN ('test_hole', 'standalone_unit',
                                                      'standalone_bulk_group')),
  test_hole_id               uuid,
  source_storage_unit_id     uuid,
  source_bulk_group_id       uuid,
  scope                      text NOT NULL DEFAULT 'all'
                               CHECK (scope IN ('all', 'grabs', 'spt', 'specific')),
  -- Specific sample: full label (G3, S3, B1, T5 …) as entered; identity compares it ignoring case.
  sample_label               text CHECK (sample_label = btrim(sample_label)
                                         AND length(sample_label) BETWEEN 1 AND 40
                                         AND sample_label !~ '[[:cntrl:]]'),
  depth_mode                 text CHECK (depth_mode IN ('point', 'interval')),
  depth_from                 numeric(8, 2) CHECK (depth_from >= 0),
  depth_to                   numeric(8, 2),
  depth_unit                 text CHECK (depth_unit IN ('ft', 'm')),
  -- Depths of the same sample identity the requester acknowledged as differing (e.g. 7.5 ft and
  -- 8 ft), as normalised depth texts. Submission needs every current variant acknowledged.
  acknowledged_depths        text[] NOT NULL DEFAULT '{}',
  -- Frozen at submission: the source as it read then, and when coverage was captured.
  source_display_snapshot    text,
  coverage_captured_at       timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- The amendment that added the line to an open program (null: part of the submission).
  amendment_id               uuid REFERENCES program_amendment (id),
  CONSTRAINT test_line_program_fk FOREIGN KEY (project_id, program_id)
    REFERENCES lab_program (project_id, id),
  -- Every source belongs to the program's project.
  CONSTRAINT test_line_test_hole_fk FOREIGN KEY (project_id, test_hole_id)
    REFERENCES test_hole (project_id, id),
  CONSTRAINT test_line_source_unit_fk FOREIGN KEY (project_id, source_storage_unit_id)
    REFERENCES storage_unit (project_id, id),
  CONSTRAINT test_line_source_bulk_group_fk FOREIGN KEY (project_id, source_bulk_group_id)
    REFERENCES bulk_group (project_id, id),
  -- Deferred so a saved draft can renumber its lines in one statement sequence.
  CONSTRAINT test_line_number_key UNIQUE (program_id, line_number) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT test_line_program_id_key UNIQUE (program_id, id),
  -- Exactly the reference its source kind names, and nothing else.
  CONSTRAINT test_line_source_check CHECK (
    CASE source_kind
      WHEN 'test_hole' THEN test_hole_id IS NOT NULL AND source_storage_unit_id IS NULL
                            AND source_bulk_group_id IS NULL
      WHEN 'standalone_unit' THEN source_storage_unit_id IS NOT NULL AND test_hole_id IS NULL
                                  AND source_bulk_group_id IS NULL
      WHEN 'standalone_bulk_group' THEN source_bulk_group_id IS NOT NULL AND test_hole_id IS NULL
                                        AND source_storage_unit_id IS NULL
      ELSE test_hole_id IS NULL AND source_storage_unit_id IS NULL AND source_bulk_group_id IS NULL
    END
  ),
  -- ALL / Grabs / SPT lines carry no label or depth; a depth always has its mode and unit.
  CONSTRAINT test_line_scope_shape_check CHECK (
    (scope <> 'specific' AND sample_label IS NULL AND depth_mode IS NULL AND depth_from IS NULL
     AND depth_to IS NULL AND depth_unit IS NULL)
    OR scope = 'specific'
  ),
  CONSTRAINT test_line_depth_shape_check CHECK (
    (depth_mode IS NULL AND depth_from IS NULL AND depth_to IS NULL)
    OR (depth_mode = 'point' AND depth_to IS NULL)
    OR (depth_mode = 'interval' AND (depth_to IS NULL OR depth_from IS NULL
                                     OR depth_to >= depth_from))
  )
);
CREATE INDEX test_line_program_idx ON test_line (program_id, line_number);
CREATE INDEX test_line_identity_idx ON test_line (project_id, upper(sample_label))
  WHERE scope = 'specific';

-- Tests picked on a draft line (current catalogue values; snapshots are taken at submission).
CREATE TABLE test_line_test (
  line_id       uuid NOT NULL REFERENCES test_line (id) ON DELETE CASCADE,
  test_type_id  uuid NOT NULL REFERENCES test_type (id),
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (line_id, test_type_id)
);

-- Units the requester explicitly chose on a draft line: Grabs/SPT units with unknown G/S
-- classification they reviewed and included, or the physical units of a Specific sample where
-- known. Same-project only.
CREATE TABLE test_line_unit_choice (
  line_id          uuid NOT NULL REFERENCES test_line (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL,
  storage_unit_id  uuid NOT NULL,
  PRIMARY KEY (line_id, storage_unit_id),
  CONSTRAINT test_line_unit_choice_unit_fk FOREIGN KEY (project_id, storage_unit_id)
    REFERENCES storage_unit (project_id, id)
);
CREATE INDEX test_line_unit_choice_unit_idx ON test_line_unit_choice (storage_unit_id);

-- Coverage frozen at submission: every candidate unit of an ALL / Grabs / SPT line (included or
-- reviewed and excluded) and the explicitly chosen units of a Specific line, with how it matched
-- and how it read then. Append-only; an amendment may append rows.
CREATE TABLE program_scope_snapshot (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                uuid NOT NULL,
  line_id                   uuid NOT NULL,
  storage_unit_id           uuid NOT NULL REFERENCES storage_unit (id),
  receipt_id                uuid NOT NULL REFERENCES receipt (id),
  -- The unit's project at capture (kept even if the unit's project is corrected later).
  project_id                uuid NOT NULL REFERENCES project (id),
  included                  boolean NOT NULL,
  -- Why the unit is (or isn't) covered:
  --   hole_summary, tube_source, bulk_group_source: it came from the selected test hole;
  --   standalone_unit, bulk_group_member: it is the selected standalone source (or a member);
  --   reviewed_included / unknown_classification_excluded: Grabs/SPT unit without structured G/S
  --     classification that the requester explicitly included or left out;
  --   explicit_selection: a physical unit the requester linked to a Specific sample.
  matching_basis            text NOT NULL
                              CHECK (matching_basis IN ('hole_summary', 'tube_source',
                                     'bulk_group_source', 'standalone_unit', 'bulk_group_member',
                                     'reviewed_included', 'unknown_classification_excluded',
                                     'explicit_selection')),
  unit_readable_id_snapshot text NOT NULL,
  unit_type_snapshot        text NOT NULL,
  contents_snapshot         text,
  received_date_snapshot    date NOT NULL,
  captured_at               timestamptz NOT NULL DEFAULT now(),
  amendment_id              uuid REFERENCES program_amendment (id),
  CONSTRAINT program_scope_snapshot_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id),
  CONSTRAINT program_scope_snapshot_unit_key UNIQUE (line_id, storage_unit_id),
  CONSTRAINT program_scope_snapshot_basis_check CHECK (
    included = (matching_basis <> 'unknown_classification_excluded')
  )
);
CREATE INDEX program_scope_snapshot_unit_idx ON program_scope_snapshot (storage_unit_id);
CREATE INDEX program_scope_snapshot_program_idx ON program_scope_snapshot (program_id);

-- ---------------------------------------------------------------------------------------------
-- Acceptance delegation (MM-T25, D04): granted and revoked by the project's Lead Project
-- Engineer; history kept. This is the one acceptance-delegate store (MM-AO02 reuses it).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE acceptance_delegation (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                   uuid NOT NULL REFERENCES project (id),
  delegate_user_id             uuid NOT NULL REFERENCES app_user (id),
  delegate_initials_snapshot   text,
  delegate_name_snapshot       text NOT NULL,
  granted_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot text,
  granted_by_name_snapshot     text NOT NULL,
  granted_at                   timestamptz NOT NULL DEFAULT now(),
  grant_idempotency_key        uuid NOT NULL UNIQUE,
  grant_request_hash           text NOT NULL,
  revoked_by_user_id           uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot text,
  revoked_by_name_snapshot     text,
  revoked_at                   timestamptz,
  -- Reasons for the grant and the revocation (D15, MM-AO02). Required for new grants and
  -- revocations once the delegation API sends them (MM-AO03); never invented for a grant.
  grant_reason                 text CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  revoke_reason                text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT acceptance_delegation_revoke_reason_revoked_check
    CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL),
  CONSTRAINT acceptance_delegation_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoked_at >= granted_at)
  )
);
-- At most one active grant per project and person; repeated grants can't stack.
CREATE UNIQUE INDEX acceptance_delegation_active_key
  ON acceptance_delegation (project_id, delegate_user_id) WHERE revoked_at IS NULL;
CREATE INDEX acceptance_delegation_project_idx ON acceptance_delegation (project_id, granted_at);

-- A grant is never deleted; the only change it ever takes is its one revocation.
CREATE FUNCTION acceptance_delegation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'acceptance delegations can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'acceptance delegation % is already revoked', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.delegate_user_id IS DISTINCT FROM OLD.delegate_user_id
     OR NEW.delegate_initials_snapshot IS DISTINCT FROM OLD.delegate_initials_snapshot
     OR NEW.delegate_name_snapshot IS DISTINCT FROM OLD.delegate_name_snapshot
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.granted_by_initials_snapshot IS DISTINCT FROM OLD.granted_by_initials_snapshot
     OR NEW.granted_by_name_snapshot IS DISTINCT FROM OLD.granted_by_name_snapshot
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.grant_idempotency_key IS DISTINCT FROM OLD.grant_idempotency_key
     OR NEW.grant_request_hash IS DISTINCT FROM OLD.grant_request_hash
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason THEN
    RAISE EXCEPTION 'acceptance delegation % grant can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_delegation_guard
  BEFORE UPDATE OR DELETE ON acceptance_delegation
  FOR EACH ROW EXECUTE FUNCTION acceptance_delegation_guard();

-- One requested test per line and test, created at submission with catalogue snapshots.
--
-- Status path (one server-side transition table, apps/api/src/lab/transitions.ts, decides what
-- may happen; the database refuses anything else and refuses status changes outside an open
-- program): requested → in_progress → completed → review → accepted, plus cancellation from
-- requested, in progress, completed or in review, and accepted → requested by an accepted-request
-- change. Review keeps its own sub-state (review_state) while the test is in Review, which is not a
-- progress stage:
--   awaiting_review → returned (return for correction, comment required)
--   awaiting_review → review_complete
--   returned → correction_done (Lab Manager, note required; acceptance still blocked)
--   correction_done → returned (a new correction cycle) or → review_complete (fresh review)
--   review_complete → accepted (status changes to accepted; review_state is cleared)
-- Returning never moves a test back to In progress. Review complete → Returned is deliberately not
-- allowed (Notion MM-T25 §12 B) until the owner decides. Acceptance records who accepted and, when
-- they did so as a delegate, the delegation used, so a later revocation never rewrites the
-- attribution.
--
-- Cancellation: a test becomes Cancelled with a required reason, actor and time (Lead Project
-- Engineer of the project or Lab Manager). Cancelled resolves the test for closure but is never
-- acceptance. Cancelling an Accepted test is not enabled, nor is restoring a cancelled test.
--
-- Repeat: a new request on the same line and test, linked to an Accepted original
-- (repeat_of_id). The original keeps its status and history; the repeat starts Requested with
-- its own history and blocks closure until resolved. It carries its original's current test,
-- sample and depth (MM-T72).
--
-- Accepted-request change (D09): changing the sample, depth or requested test of an Accepted
-- request resets only that request to Requested, clears its current review and acceptance and
-- needs a fresh review and acceptance. Each change is an append-only identity revision with the
-- before/after values and reason; earlier review events keep the historical acceptance. A
-- request's sample/depth may differ from its line's (the line is shared with its other tests), so
-- the request keeps its own current identity in override columns.
CREATE TABLE test_request (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                  uuid NOT NULL,
  line_id                     uuid NOT NULL,
  test_type_id                uuid NOT NULL REFERENCES test_type (id),
  test_code_snapshot          text NOT NULL,
  test_name_snapshot          text,
  test_description_snapshot   text NOT NULL,
  test_group_snapshot         text NOT NULL,
  test_subgroup_snapshot      text,
  sort_order                  integer NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'requested'
                                CHECK (status IN ('requested', 'in_progress', 'completed', 'review',
                                                  'accepted', 'cancelled')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status_changed_at           timestamptz,
  status_changed_by_account_user_id uuid REFERENCES app_user (id),
  status_changed_for_user_id  uuid REFERENCES app_user (id),
  review_state                text
    CHECK (review_state IN ('awaiting_review', 'returned', 'correction_done', 'review_complete')),
  accepted_at                 timestamptz,
  accepted_by_user_id         uuid REFERENCES app_user (id),
  -- The grant used when the acceptor accepted as a delegate (null for the project's Lead Project
  -- Engineer).
  accepted_via_delegation_id  uuid REFERENCES acceptance_delegation (id),
  cancel_reason               text CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 2000),
  cancelled_at                timestamptz,
  cancelled_by_user_id        uuid REFERENCES app_user (id),
  cancelled_by_initials_snapshot text,
  cancelled_by_name_snapshot  text,
  -- A genuine repeat: the original it repeats (same program and line).
  repeat_of_id                uuid REFERENCES test_request (id),
  -- Requests made after submission (repeats, amendments) record who made them and the retry key,
  -- so an exact retry returns the same request.
  created_by_user_id          uuid REFERENCES app_user (id),
  created_by_name_snapshot    text,
  create_idempotency_key      uuid UNIQUE,
  create_request_hash         text,
  amendment_id                uuid REFERENCES program_amendment (id),
  identity_revision           integer NOT NULL DEFAULT 0 CHECK (identity_revision >= 0),
  -- The request's own Specific sample/depth when changed after acceptance (null: the line's).
  sample_label_override       text
    CHECK (sample_label_override = btrim(sample_label_override)
           AND length(sample_label_override) BETWEEN 1 AND 40
           AND sample_label_override !~ '[[:cntrl:]]'),
  depth_mode_override         text CHECK (depth_mode_override IN ('point', 'interval')),
  depth_from_override         numeric(8, 2) CHECK (depth_from_override >= 0),
  depth_to_override           numeric(8, 2),
  depth_unit_override         text CHECK (depth_unit_override IN ('ft', 'm')),
  CONSTRAINT test_request_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id),
  CONSTRAINT test_request_review_state_shape_check
    CHECK ((status = 'review') = (review_state IS NOT NULL)),
  CONSTRAINT test_request_accepted_shape_check CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
    OR (status <> 'accepted' AND accepted_at IS NULL AND accepted_by_user_id IS NULL
        AND accepted_via_delegation_id IS NULL)
  ),
  CONSTRAINT test_request_cancelled_shape_check CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
     AND cancelled_by_name_snapshot IS NOT NULL AND cancel_reason IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
        AND cancelled_by_initials_snapshot IS NULL AND cancelled_by_name_snapshot IS NULL
        AND cancel_reason IS NULL)
  ),
  CONSTRAINT test_request_repeat_shape_check CHECK (
    repeat_of_id IS NULL
    OR (created_by_user_id IS NOT NULL AND create_idempotency_key IS NOT NULL
        AND create_request_hash IS NOT NULL AND repeat_of_id <> id)
  ),
  CONSTRAINT test_request_identity_override_check CHECK (
    (sample_label_override IS NULL AND depth_mode_override IS NULL
     AND depth_from_override IS NULL AND depth_to_override IS NULL
     AND depth_unit_override IS NULL)
    OR (sample_label_override IS NOT NULL AND depth_mode_override IS NOT NULL
        AND depth_from_override IS NOT NULL AND depth_unit_override IS NOT NULL
        AND ((depth_mode_override = 'point' AND depth_to_override IS NULL)
             OR (depth_mode_override = 'interval' AND depth_to_override IS NOT NULL
                 AND depth_to_override >= depth_from_override)))
  )
);
CREATE INDEX test_request_program_idx ON test_request (program_id);
CREATE INDEX test_request_test_type_idx ON test_request (test_type_id);
CREATE INDEX test_request_status_idx ON test_request (program_id, status);
-- One original request per line and test; repeats of it are linked rows.
CREATE UNIQUE INDEX test_request_line_test_key
  ON test_request (line_id, test_type_id) WHERE repeat_of_id IS NULL;
CREATE INDEX test_request_repeat_of_idx ON test_request (repeat_of_id) WHERE repeat_of_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Worklist history, comments and exact tested-unit evidence (MM-T24, T73)
-- ---------------------------------------------------------------------------------------------
--
-- Every status change, priority change, comment and comment edit is an append-only history row
-- carrying the authenticated account and, for a shared LAB station, the selected staff member
-- ("LAB for person"), with snapshots. Each also stores the client's retry key and a hash of its
-- intent, so an exact retry returns the original result and a different intent under the same
-- key is refused, without duplicating history.
--
-- Tested-unit evidence: a completion may link the exact physical storage units actually used.
-- Coverage, source, receipt or group membership is never treated as evidence. Completion changes
-- no unit: physical removal after testing is MM-T36's separate personal-account action, which
-- reads this evidence. Each link says why it is allowed (MM-T73, owner decision 2026-10-28):
--   frozen_coverage        the unit is included in the line's frozen coverage (no confirmation);
--   same_source_confirmed  the unit is outside that coverage, but is a Shelby tube or bulk-sample
--                          bucket of the line's source in the program's project, and the account
--                          and person of the completion confirmed it (who and when are kept).
-- The confirmed link is ordinary exact-unit evidence: it destroys a tube's contents for other
-- programs and is the basis for removal after testing. Coverage itself is never changed. The
-- database refuses any other link: a unit of another source or project, an ordinary bucket
-- outside coverage, a confirmation for a covered unit, or a confirmation by someone other than
-- the completion's own account and person.

CREATE TABLE test_request_status_history (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id            uuid NOT NULL REFERENCES test_request (id),
  program_id                 uuid NOT NULL REFERENCES lab_program (id),
  from_status                text NOT NULL,
  to_status                  text NOT NULL,
  account_user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type               text NOT NULL CHECK (account_type IN ('personal', 'shared_lab', 'test')),
  account_initials_snapshot  text,
  account_name_snapshot      text NOT NULL,
  person_user_id             uuid NOT NULL REFERENCES app_user (id),
  person_initials_snapshot   text,
  person_name_snapshot       text NOT NULL,
  changed_at                 timestamptz NOT NULL DEFAULT now(),
  idempotency_key            uuid NOT NULL UNIQUE,
  request_hash               text NOT NULL,
  CONSTRAINT test_request_status_history_transition_check CHECK (
    (from_status, to_status) IN (('requested', 'in_progress'), ('in_progress', 'completed'),
                                 ('completed', 'review'), ('review', 'accepted'),
                                 ('requested', 'cancelled'), ('in_progress', 'cancelled'),
                                 ('completed', 'cancelled'), ('review', 'cancelled'),
                                 ('accepted', 'requested'))
  )
);
CREATE INDEX test_request_status_history_request_idx
  ON test_request_status_history (test_request_id, changed_at);

-- Exact physical units used by a completed test (append-only evidence). A completed test may be
-- completed again after an accepted-request change resets it; each completion keeps its own
-- evidence, so there is one link per completion and unit.
CREATE TABLE test_request_unit_link (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id     uuid NOT NULL REFERENCES test_request (id),
  -- The completion event that recorded the link (actor, person and time live there).
  status_history_id   uuid NOT NULL REFERENCES test_request_status_history (id),
  storage_unit_id     uuid NOT NULL REFERENCES storage_unit (id),
  -- The unit's project when linked; must be the program's project.
  project_id          uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot text NOT NULL,
  linked_at           timestamptz NOT NULL DEFAULT now(),
  coverage_basis      text NOT NULL DEFAULT 'frozen_coverage'
                        CHECK (coverage_basis IN ('frozen_coverage', 'same_source_confirmed')),
  confirmed_by_account_user_id uuid REFERENCES app_user (id),
  confirmed_by_person_user_id uuid REFERENCES app_user (id),
  confirmed_by_person_initials_snapshot text,
  confirmed_by_person_name_snapshot text,
  confirmed_at        timestamptz,
  CONSTRAINT test_request_unit_link_key UNIQUE (status_history_id, storage_unit_id),
  CONSTRAINT test_request_unit_link_confirmation_shape CHECK (
    (coverage_basis = 'frozen_coverage' AND confirmed_by_account_user_id IS NULL
     AND confirmed_by_person_user_id IS NULL AND confirmed_by_person_initials_snapshot IS NULL
     AND confirmed_by_person_name_snapshot IS NULL AND confirmed_at IS NULL)
    OR (coverage_basis = 'same_source_confirmed' AND confirmed_by_account_user_id IS NOT NULL
        AND confirmed_by_person_user_id IS NOT NULL
        AND length(btrim(confirmed_by_person_name_snapshot)) > 0 AND confirmed_at IS NOT NULL)
  )
);
CREATE INDEX test_request_unit_link_unit_idx ON test_request_unit_link (storage_unit_id);
CREATE INDEX test_request_unit_link_request_idx ON test_request_unit_link (test_request_id);

CREATE TABLE program_priority_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id            uuid NOT NULL REFERENCES lab_program (id),
  from_priority         text NOT NULL CHECK (from_priority IN ('normal', 'urgent')),
  to_priority           text NOT NULL CHECK (to_priority IN ('normal', 'urgent')),
  user_id               uuid NOT NULL REFERENCES app_user (id),
  initials_snapshot     text,
  name_snapshot         text NOT NULL,
  changed_at            timestamptz NOT NULL DEFAULT now(),
  idempotency_key       uuid NOT NULL UNIQUE,
  request_hash          text NOT NULL,
  CHECK (from_priority <> to_priority)
);
CREATE INDEX program_priority_history_program_idx ON program_priority_history (program_id, changed_at);

CREATE TABLE lab_comment (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id                        uuid NOT NULL REFERENCES lab_program (id),
  -- Null for a comment on the whole program.
  line_id                           uuid,
  author_account_user_id            uuid NOT NULL REFERENCES app_user (id),
  author_account_type               text NOT NULL
                                      CHECK (author_account_type IN ('personal', 'shared_lab', 'test')),
  author_account_name_snapshot      text NOT NULL,
  -- The person who wrote it: the account's own person, or the LAB station's selected person.
  author_person_user_id             uuid NOT NULL REFERENCES app_user (id),
  author_person_initials_snapshot   text,
  author_person_name_snapshot       text NOT NULL,
  body                              text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  edited_at                         timestamptz,
  version                           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_key                   uuid NOT NULL UNIQUE,
  request_hash                      text NOT NULL,
  CONSTRAINT lab_comment_line_fk FOREIGN KEY (program_id, line_id)
    REFERENCES test_line (program_id, id)
);
CREATE INDEX lab_comment_program_idx ON lab_comment (program_id, line_id, created_at);

-- Every text a comment has had, in order: revision 1 is the original.
CREATE TABLE lab_comment_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id         uuid NOT NULL REFERENCES lab_comment (id),
  revision_number    integer NOT NULL CHECK (revision_number >= 1),
  body               text NOT NULL,
  account_user_id    uuid NOT NULL REFERENCES app_user (id),
  person_user_id     uuid NOT NULL REFERENCES app_user (id),
  person_initials_snapshot text,
  person_name_snapshot     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT lab_comment_revision_key UNIQUE (comment_id, revision_number)
);

-- Review decisions (MM-T25). Every decision is an append-only event with the authenticated
-- personal account (review and acceptance are never LAB actions, so the account is the person),
-- its retry key and intent hash. A return opens one action_item for the Lab Manager role; marking
-- the correction done resolves exactly that item.
CREATE TABLE test_request_review_event (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id       uuid NOT NULL REFERENCES test_request (id),
  program_id            uuid NOT NULL REFERENCES lab_program (id),
  kind                  text NOT NULL
                          CHECK (kind IN ('review_completed', 'returned', 'correction_done',
                                          'accepted')),
  from_review_state     text NOT NULL,
  -- Null for acceptance (the test leaves Review).
  to_review_state       text,
  -- The return comment or the correction note; required for exactly those two.
  comment               text CHECK (length(btrim(comment)) BETWEEN 1 AND 4000),
  -- The correction cycle the event belongs to (1 = first return); 0 before any return.
  correction_cycle      integer NOT NULL CHECK (correction_cycle >= 0),
  user_id               uuid NOT NULL REFERENCES app_user (id),
  account_type          text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot     text,
  name_snapshot         text NOT NULL,
  -- For acceptance by a delegate: the grant that authorised it (kept after revocation).
  delegation_id         uuid REFERENCES acceptance_delegation (id),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  idempotency_key       uuid NOT NULL UNIQUE,
  request_hash          text NOT NULL,
  CONSTRAINT test_request_review_event_comment_required_check CHECK (
    (kind IN ('returned', 'correction_done')) = (comment IS NOT NULL)
  ),
  CONSTRAINT test_request_review_event_delegation_check CHECK (
    delegation_id IS NULL OR kind = 'accepted'
  )
);
CREATE INDEX test_request_review_event_request_idx
  ON test_request_review_event (test_request_id, occurred_at);
CREATE INDEX test_request_review_event_program_idx
  ON test_request_review_event (program_id, occurred_at);

CREATE TABLE program_lifecycle_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid NOT NULL REFERENCES lab_program (id),
  kind               text NOT NULL CHECK (kind IN ('closed', 'reopened')),
  -- Required to reopen; closing records none.
  reason             text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot  text,
  name_snapshot      text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT program_lifecycle_event_reason_kind_check CHECK ((kind = 'reopened') = (reason IS NOT NULL))
);
CREATE INDEX program_lifecycle_event_program_idx
  ON program_lifecycle_event (program_id, occurred_at);

CREATE TABLE test_request_identity_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id    uuid NOT NULL REFERENCES test_request (id),
  program_id         uuid NOT NULL REFERENCES lab_program (id),
  revision_number    integer NOT NULL CHECK (revision_number >= 1),
  -- Sample, depth and test as they were and as they became (display values and IDs).
  before             jsonb NOT NULL,
  after              jsonb NOT NULL,
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  user_id            uuid NOT NULL REFERENCES app_user (id),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'test')),
  initials_snapshot  text,
  name_snapshot      text NOT NULL,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  idempotency_key    uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  CONSTRAINT test_request_identity_revision_key UNIQUE (test_request_id, revision_number)
);
CREATE INDEX test_request_identity_revision_program_idx
  ON test_request_identity_revision (program_id, changed_at);

-- ---------------------------------------------------------------------------------------------
-- Lab lifecycle integrity
-- ---------------------------------------------------------------------------------------------

-- History, evidence, comment revisions, decisions and amendments are append-only; comments are
-- never deleted (their text changes only by an edit, which adds a revision).
CREATE FUNCTION lab_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows can''t be changed or removed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER test_request_status_history_append_only
  BEFORE UPDATE OR DELETE ON test_request_status_history
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER test_request_unit_link_append_only
  BEFORE UPDATE OR DELETE ON test_request_unit_link
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER program_priority_history_append_only
  BEFORE UPDATE OR DELETE ON program_priority_history
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER lab_comment_revision_append_only
  BEFORE UPDATE OR DELETE ON lab_comment_revision
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER test_request_review_event_append_only
  BEFORE UPDATE OR DELETE ON test_request_review_event
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER program_lifecycle_event_append_only
  BEFORE UPDATE OR DELETE ON program_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER program_amendment_append_only
  BEFORE UPDATE OR DELETE ON program_amendment
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER test_request_identity_revision_append_only
  BEFORE UPDATE OR DELETE ON test_request_identity_revision
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

CREATE FUNCTION lab_comment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'comments can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.author_account_user_id IS DISTINCT FROM OLD.author_account_user_id
     OR NEW.author_person_user_id IS DISTINCT FROM OLD.author_person_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'comment % authorship can''t change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_comment_guard
  BEFORE UPDATE OR DELETE ON lab_comment
  FOR EACH ROW EXECUTE FUNCTION lab_comment_guard();

-- A program never returns to draft and never changes project; a submitted program's submission
-- facts are permanent. Submitting needs every line complete (source, tests, Specific identity).
CREATE FUNCTION lab_program_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  problem text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'program % has been submitted and can''t be deleted', OLD.program_number
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'program % project can''t change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft'
       OR NEW.program_number IS DISTINCT FROM OLD.program_number
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_account_user_id IS DISTINCT FROM OLD.submitted_by_account_user_id
       OR NEW.submitted_for_user_id IS DISTINCT FROM OLD.submitted_for_user_id
       OR NEW.submit_idempotency_key IS DISTINCT FROM OLD.submit_idempotency_key
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
       OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'program % has been submitted; its submission can''t change',
        OLD.program_number USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status = 'closed' THEN
    RAISE EXCEPTION 'a draft program can''t be closed; submit or discard it'
      USING ERRCODE = 'restrict_violation';
  ELSIF NEW.status = 'submitted' THEN
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id)
               THEN 'has no testing lines'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id AND source_kind IS NULL)
               THEN 'has a line without a sampling source'
             WHEN EXISTS (SELECT 1 FROM test_line l WHERE l.program_id = NEW.id
                          AND NOT EXISTS (SELECT 1 FROM test_request r WHERE r.line_id = l.id))
               THEN 'has a line without requested tests'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id AND scope = 'specific'
                          AND (sample_label IS NULL OR depth_mode IS NULL OR depth_from IS NULL
                               OR depth_unit IS NULL
                               OR (depth_mode = 'interval' AND depth_to IS NULL)))
               THEN 'has a specific sample without label, depth and unit'
             WHEN EXISTS (SELECT 1 FROM test_line WHERE program_id = NEW.id
                          AND (source_display_snapshot IS NULL OR coverage_captured_at IS NULL))
               THEN 'has a line whose coverage was not captured'
           END INTO problem;
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'program % %', NEW.id, problem
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_complete_on_submit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_program_guard
  BEFORE UPDATE OR DELETE ON lab_program
  FOR EACH ROW EXECUTE FUNCTION lab_program_guard();

-- Closing needs at least one request and every request resolved (Accepted, or Cancelled with a
-- reason). Checked here as well as in the service, which locks the program and its requests first.
CREATE FUNCTION lab_program_closure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total integer;
  unresolved integer;
BEGIN
  -- A draft is refused by lab_program_guard (restrict_violation); this checks open programs.
  IF NEW.status = 'closed' AND OLD.status = 'submitted' THEN
    SELECT count(*),
           count(*) FILTER (WHERE NOT (status = 'accepted'
                                       OR (status = 'cancelled' AND cancel_reason IS NOT NULL)))
      INTO total, unresolved
      FROM test_request WHERE program_id = NEW.id;
    IF total = 0 THEN
      RAISE EXCEPTION 'program % has no test requests and can''t be closed', NEW.program_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_closure';
    END IF;
    IF unresolved > 0 THEN
      RAISE EXCEPTION 'program % has % unresolved test request(s)', NEW.program_number, unresolved
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lab_program_closure';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lab_program_closure_guard
  BEFORE UPDATE OF status ON lab_program
  FOR EACH ROW EXECUTE FUNCTION lab_program_closure_guard();

-- Lines, picked tests and unit choices change only while their program is a draft. The line's
-- frozen snapshot columns may be written once, in the submission transaction (still draft).
CREATE FUNCTION lab_program_is_draft(program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT status = 'draft' FROM lab_program WHERE id = program
$$;

CREATE FUNCTION lab_program_is_open(program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT status = 'submitted' FROM lab_program WHERE id = program
$$;

-- An amendment's rows belong to the amendment's program.
CREATE FUNCTION lab_amendment_program_matches(amendment uuid, program uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM program_amendment WHERE id = amendment AND program_id = program)
$$;

-- Lines change only while their program is a draft, except that an amendment may add a complete
-- line (source and frozen display/capture set) to an open program. Amended lines never change.
CREATE FUNCTION test_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program uuid;
BEGIN
  program := CASE WHEN TG_OP = 'DELETE' THEN OLD.program_id ELSE NEW.program_id END;
  IF TG_OP = 'INSERT' AND NEW.amendment_id IS NOT NULL THEN
    IF NOT coalesce(lab_program_is_open(program), false)
       OR NOT lab_amendment_program_matches(NEW.amendment_id, program)
       OR NEW.source_kind IS NULL OR NEW.source_display_snapshot IS NULL
       OR NEW.coverage_captured_at IS NULL THEN
      RAISE EXCEPTION 'an amendment adds a complete line to an open program only'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce(lab_program_is_draft(program), true) THEN
    RAISE EXCEPTION 'testing lines of a submitted program can''t change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER test_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line
  FOR EACH ROW EXECUTE FUNCTION test_line_guard();

CREATE FUNCTION test_line_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  line uuid;
BEGIN
  line := CASE WHEN TG_OP = 'DELETE' THEN OLD.line_id ELSE NEW.line_id END;
  IF NOT coalesce((SELECT lab_program_is_draft(program_id) FROM test_line WHERE id = line), true)
  THEN
    RAISE EXCEPTION '% of a submitted program can''t change', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER test_line_test_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line_test
  FOR EACH ROW EXECUTE FUNCTION test_line_child_guard();
CREATE TRIGGER test_line_unit_choice_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_line_unit_choice
  FOR EACH ROW EXECUTE FUNCTION test_line_child_guard();

-- Coverage is frozen at submission; an amendment may append rows (never change or remove one).
CREATE FUNCTION program_scope_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'frozen coverage can''t be changed or removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amendment_id IS NOT NULL THEN
    IF NOT coalesce(lab_program_is_open(NEW.program_id), false)
       OR NOT lab_amendment_program_matches(NEW.amendment_id, NEW.program_id) THEN
      RAISE EXCEPTION 'an amendment adds coverage to an open program only'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT coalesce(lab_program_is_draft(NEW.program_id), false) THEN
    RAISE EXCEPTION 'coverage is frozen when the program is submitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER program_scope_snapshot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON program_scope_snapshot
  FOR EACH ROW EXECUTE FUNCTION program_scope_snapshot_guard();

-- Requests are created at submission, as a linked repeat or by an amendment while the program is
-- open. Snapshots, links and creators never change, except that an identity change (accepted
-- test, revision + 1, back to Requested) may replace the test snapshot and the sample/depth. An
-- inserted repeat whose test snapshot or sample/depth differs from its original's is refused
-- (test_request_repeat_identity, MM-T72).
CREATE FUNCTION test_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_status text;
  revising boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'test requests can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO program_status FROM lab_program WHERE id = NEW.program_id;
    IF NEW.repeat_of_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted' THEN
        RAISE EXCEPTION 'a repeat needs an open program' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM test_request o
                     WHERE o.id = NEW.repeat_of_id AND o.program_id = NEW.program_id
                       AND o.line_id = NEW.line_id AND o.test_type_id = NEW.test_type_id) THEN
        RAISE EXCEPTION 'a repeat must link to a request of the same line and test'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
      IF NOT EXISTS (
           SELECT 1 FROM test_request o
           WHERE o.id = NEW.repeat_of_id
             AND o.test_code_snapshot IS NOT DISTINCT FROM NEW.test_code_snapshot
             AND o.test_name_snapshot IS NOT DISTINCT FROM NEW.test_name_snapshot
             AND o.test_description_snapshot IS NOT DISTINCT FROM NEW.test_description_snapshot
             AND o.test_group_snapshot IS NOT DISTINCT FROM NEW.test_group_snapshot
             AND o.test_subgroup_snapshot IS NOT DISTINCT FROM NEW.test_subgroup_snapshot
             AND o.sample_label_override IS NOT DISTINCT FROM NEW.sample_label_override
             AND o.depth_mode_override IS NOT DISTINCT FROM NEW.depth_mode_override
             AND o.depth_from_override IS NOT DISTINCT FROM NEW.depth_from_override
             AND o.depth_to_override IS NOT DISTINCT FROM NEW.depth_to_override
             AND o.depth_unit_override IS NOT DISTINCT FROM NEW.depth_unit_override) THEN
        RAISE EXCEPTION 'a repeat keeps its original''s current test, sample and depth'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat_identity';
      END IF;
      IF NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'a repeat starts Requested'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
    ELSIF NEW.amendment_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted'
         OR NOT lab_amendment_program_matches(NEW.amendment_id, NEW.program_id)
         OR NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'an amendment adds Requested tests to an open program only'
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF program_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'test requests are created when the program is submitted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  revising := NEW.identity_revision = OLD.identity_revision + 1
              AND OLD.status = 'accepted' AND NEW.status = 'requested';
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.repeat_of_id IS DISTINCT FROM OLD.repeat_of_id
     OR NEW.amendment_id IS DISTINCT FROM OLD.amendment_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
     OR NEW.identity_revision < OLD.identity_revision
     OR (NEW.identity_revision > OLD.identity_revision AND NOT revising)
     OR (NOT revising AND (
           NEW.test_type_id IS DISTINCT FROM OLD.test_type_id
           OR NEW.test_code_snapshot IS DISTINCT FROM OLD.test_code_snapshot
           OR NEW.test_name_snapshot IS DISTINCT FROM OLD.test_name_snapshot
           OR NEW.test_description_snapshot IS DISTINCT FROM OLD.test_description_snapshot
           OR NEW.test_group_snapshot IS DISTINCT FROM OLD.test_group_snapshot
           OR NEW.test_subgroup_snapshot IS DISTINCT FROM OLD.test_subgroup_snapshot
           OR NEW.sample_label_override IS DISTINCT FROM OLD.sample_label_override
           OR NEW.depth_mode_override IS DISTINCT FROM OLD.depth_mode_override
           OR NEW.depth_from_override IS DISTINCT FROM OLD.depth_from_override
           OR NEW.depth_to_override IS DISTINCT FROM OLD.depth_to_override
           OR NEW.depth_unit_override IS DISTINCT FROM OLD.depth_unit_override)) THEN
    RAISE EXCEPTION 'test request % snapshot is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_guard
  BEFORE INSERT OR UPDATE OR DELETE ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_guard();

-- Status and review sub-state change only along the shared table, only while the program is open.
-- Accepted → Requested only with a new identity revision (an accepted-request change).
CREATE FUNCTION test_request_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('requested', 'in_progress'),
                                        ('in_progress', 'completed'),
                                        ('completed', 'review'),
                                        ('review', 'accepted'),
                                        ('requested', 'cancelled'),
                                        ('in_progress', 'cancelled'),
                                        ('completed', 'cancelled'),
                                        ('review', 'cancelled'),
                                        ('accepted', 'requested')) THEN
      RAISE EXCEPTION 'test request % can''t move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF NEW.status = 'accepted' AND OLD.review_state IS DISTINCT FROM 'review_complete' THEN
      RAISE EXCEPTION 'test request % can''t be accepted before its review is complete', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF NEW.status = 'review' AND NEW.review_state IS DISTINCT FROM 'awaiting_review' THEN
      RAISE EXCEPTION 'test request % enters review awaiting review', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
    IF OLD.status = 'accepted' AND NEW.identity_revision <> OLD.identity_revision + 1 THEN
      RAISE EXCEPTION 'test request % returns to Requested only through an identity change', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
  ELSIF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    IF (OLD.review_state, NEW.review_state) NOT IN (('awaiting_review', 'returned'),
                                                    ('awaiting_review', 'review_complete'),
                                                    ('returned', 'correction_done'),
                                                    ('correction_done', 'returned'),
                                                    ('correction_done', 'review_complete')) THEN
      RAISE EXCEPTION 'test request % review can''t move from % to %', OLD.id,
        OLD.review_state, NEW.review_state
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_transition';
    END IF;
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.review_state IS DISTINCT FROM OLD.review_state)
     AND (SELECT status FROM lab_program WHERE id = OLD.program_id) <> 'submitted' THEN
    RAISE EXCEPTION 'tests of a program that isn''t open can''t change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_status_guard
  BEFORE UPDATE OF status, review_state, identity_revision ON test_request
  FOR EACH ROW EXECUTE FUNCTION test_request_status_guard();

-- ---------------------------------------------------------------------------------------------
-- Tested-unit evidence guard and removal of tested Shelby tubes and bulk buckets (MM-T36, T76)
-- ---------------------------------------------------------------------------------------------
--
-- Two separate facts, never inferred from each other:
--   1. Testing (MM-T24): a completion linked the exact physical unit (test_request_unit_link).
--      For a Shelby tube that alone means its contents were destroyed during testing and are
--      unusable: the tube can't be covered by a new program or linked as tested by another
--      program. The tube itself stays in stock at its saved location.
--   2. Physical removal: a personal account confirms that the whole unit has actually left the
--      lab, naming the completed test that used it. The unit becomes `disposed` (shown "Disposed
--      after testing"), keeps its last saved location as history and no longer occupies that
--      location or counts as Current stock.
--
-- The post-testing route is the T36 exception: no retention wait, extension or hold, disposal
-- approval, standard disposal scan or covering-program closure applies. It never changes test
-- requests, review, acceptance or program status, and never touches sibling tubes or buckets.
--
-- Eligible units: a Shelby tube (reason tested_shelby) or a bucket holding a bulk soil sample,
-- i.e. unit_type bulk_container in a bulk group (reason tested_bulk), with a completion link of
-- a request that is not cancelled. Ordinary buckets never qualify.

-- The program whose completion first used this Shelby tube, or null when its contents are
-- still available (not a tube, or no completed test linked to it). A cancelled request's link
-- doesn't count.
CREATE FUNCTION shelby_contents_destroyed_by_program(unit_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.program_id
  FROM storage_unit su
  JOIN test_request_unit_link l ON l.storage_unit_id = su.id
  JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
  JOIN test_request r ON r.id = l.test_request_id
  WHERE su.id = unit_id AND su.unit_type = 'shelby_tube' AND r.status <> 'cancelled'
  ORDER BY h.changed_at, h.id
  LIMIT 1
$$;

-- True when `unit_id` is a unit of `line_id`'s sampling source in the line's project, by the
-- same rules as coverage candidates (apps/api/src/lab/coverage.ts), ignoring availability:
--   test hole             → a hole summary for the hole, a tube sourced from it, or a bucket of
--                           a bulk group sourced from it;
--   standalone tube       → that tube;
--   standalone bulk group → its member buckets.
CREATE FUNCTION storage_unit_of_line_source(line_id uuid, unit_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM test_line tl JOIN storage_unit su ON su.id = unit_id AND su.project_id = tl.project_id
    WHERE tl.id = line_id AND CASE tl.source_kind
      WHEN 'test_hole' THEN
        su.source_test_hole_id = tl.test_hole_id
        OR EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                   WHERE h.storage_unit_id = su.id AND h.test_hole_id = tl.test_hole_id)
        OR EXISTS (SELECT 1 FROM bulk_group g
                   WHERE g.id = su.bulk_group_id AND g.test_hole_id = tl.test_hole_id)
      WHEN 'standalone_unit' THEN su.id = tl.source_storage_unit_id
      WHEN 'standalone_bulk_group' THEN su.bulk_group_id = tl.source_bulk_group_id
      ELSE false
    END
  )
$$;

-- Backstop for the lab service: tested-unit evidence never names a disposed unit, stays inside
-- the program's project, matches its coverage basis, and a Shelby tube whose contents another
-- program already destroyed can't be tested again (tests of the same program, frozen together at
-- submission, may still record the tube). The guard takes the unit's row lock (NO KEY UPDATE: it
-- serialises with other completions, moves, corrections, removal and disposal, which all lock the
-- unit, but not with foreign-key checks) before reading, so two programs can't both record the
-- same tube (MM-T76). The lab service takes the same lock first (units before the request), so in
-- the service path this re-lock never waits.
CREATE FUNCTION test_request_unit_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
  destroyed_by uuid;
  req record;
  event record;
  covered boolean;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id FOR NO KEY UPDATE;
  IF unit.status = 'disposed' THEN
    RAISE EXCEPTION 'storage unit % is disposed and can''t be linked as tested', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_not_disposed';
  END IF;
  destroyed_by := shelby_contents_destroyed_by_program(NEW.storage_unit_id);
  SELECT r.program_id, r.line_id, lp.project_id INTO req
  FROM test_request r JOIN lab_program lp ON lp.id = r.program_id
  WHERE r.id = NEW.test_request_id;
  IF destroyed_by IS NOT NULL AND destroyed_by <> req.program_id THEN
    RAISE EXCEPTION 'Shelby tube % contents were destroyed during testing', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_contents_available';
  END IF;
  -- Evidence stays inside the program's project.
  IF NEW.project_id <> req.project_id OR unit.project_id <> req.project_id THEN
    RAISE EXCEPTION 'storage unit % is not in this program''s project', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_same_project';
  END IF;
  covered := EXISTS (SELECT 1 FROM program_scope_snapshot s
                     WHERE s.line_id = req.line_id AND s.storage_unit_id = NEW.storage_unit_id
                       AND s.included);
  IF NEW.coverage_basis = 'frozen_coverage' THEN
    IF NOT covered THEN
      RAISE EXCEPTION 'storage unit % is not part of this line''s coverage', unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_covered';
    END IF;
  ELSE
    IF covered
       OR NOT (unit.unit_type = 'shelby_tube' OR unit.bulk_group_id IS NOT NULL)
       OR NOT storage_unit_of_line_source(req.line_id, NEW.storage_unit_id) THEN
      RAISE EXCEPTION 'storage unit % can''t be confirmed as same-source tested material',
        unit.readable_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_same_source';
    END IF;
    -- The confirmation is the completion's own: same account and person as its event.
    SELECT h.account_user_id, h.person_user_id, h.test_request_id, h.to_status INTO event
    FROM test_request_status_history h WHERE h.id = NEW.status_history_id;
    IF event.test_request_id IS DISTINCT FROM NEW.test_request_id
       OR event.to_status IS DISTINCT FROM 'completed'
       OR event.account_user_id IS DISTINCT FROM NEW.confirmed_by_account_user_id
       OR event.person_user_id IS DISTINCT FROM NEW.confirmed_by_person_user_id THEN
      RAISE EXCEPTION 'a same-source confirmation must be made by the completion''s own account and person'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_unit_link_confirmed_by_completer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_request_unit_link_guard
  BEFORE INSERT ON test_request_unit_link
  FOR EACH ROW EXECUTE FUNCTION test_request_unit_link_guard();

CREATE TABLE tested_unit_removal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One removal per physical unit, ever: retries and concurrent requests can't add a second.
  storage_unit_id             uuid NOT NULL UNIQUE REFERENCES storage_unit (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot   text NOT NULL,
  unit_type_snapshot          text NOT NULL CHECK (unit_type_snapshot IN ('shelby_tube', 'bulk_container')),
  bulk_group_id_snapshot      uuid REFERENCES bulk_group (id),
  reason                      text NOT NULL CHECK (reason IN ('tested_shelby', 'tested_bulk')),
  -- The completed test the person named as the basis, and its completion event.
  test_request_id             uuid NOT NULL REFERENCES test_request (id),
  unit_link_id                uuid NOT NULL REFERENCES test_request_unit_link (id),
  completion_event_id         uuid NOT NULL REFERENCES test_request_status_history (id),
  program_number_snapshot     text NOT NULL,
  test_code_snapshot          text NOT NULL,
  -- The unit as it was just before removal. The location stays on storage_unit as history.
  previous_status             text NOT NULL CHECK (previous_status IN ('in_stock', 'approved_for_disposal')),
  location_id                 uuid NOT NULL REFERENCES location (id),
  location_code_snapshot      text NOT NULL,
  location_name_snapshot      text NOT NULL,
  -- The personal account that confirmed the physical removal (never LAB).
  removed_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  removed_by_account_type     text NOT NULL CHECK (removed_by_account_type IN ('personal', 'test')),
  removed_by_initials_snapshot text,
  removed_by_name_snapshot    text NOT NULL,
  physical_removal_confirmed  boolean NOT NULL CHECK (physical_removal_confirmed),
  removed_at                  timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  CONSTRAINT tested_unit_removal_reason_matches_type CHECK (
    (reason = 'tested_shelby' AND unit_type_snapshot = 'shelby_tube' AND bulk_group_id_snapshot IS NULL)
    OR (reason = 'tested_bulk' AND unit_type_snapshot = 'bulk_container'
        AND bulk_group_id_snapshot IS NOT NULL)
  )
);
CREATE INDEX tested_unit_removal_project_idx ON tested_unit_removal (project_id, removed_at);
CREATE INDEX tested_unit_removal_request_idx ON tested_unit_removal (test_request_id);

CREATE TRIGGER tested_unit_removal_append_only
  BEFORE UPDATE OR DELETE ON tested_unit_removal
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- A removal row is written in the transaction that disposes the unit, after the unit update,
-- and must rest on real exact-unit evidence of a request that isn't cancelled.
CREATE FUNCTION tested_unit_removal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit.status <> 'disposed' OR unit.project_id <> NEW.project_id
     OR unit.unit_type <> NEW.unit_type_snapshot
     OR unit.bulk_group_id IS DISTINCT FROM NEW.bulk_group_id_snapshot
     OR unit.current_location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'tested removal of % doesn''t match the unit', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tested_unit_removal_matches_unit';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM test_request_unit_link l
    JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
    JOIN test_request r ON r.id = l.test_request_id
    JOIN lab_program lp ON lp.id = r.program_id
    WHERE l.id = NEW.unit_link_id AND l.storage_unit_id = NEW.storage_unit_id
      AND l.test_request_id = NEW.test_request_id AND h.id = NEW.completion_event_id
      AND l.project_id = NEW.project_id AND lp.project_id = NEW.project_id
      AND r.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'tested removal of % needs completed-test evidence for that exact unit',
      unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tested_unit_removal_evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tested_unit_removal_guard
  BEFORE INSERT ON tested_unit_removal
  FOR EACH ROW EXECUTE FUNCTION tested_unit_removal_guard();

-- A unit removed after testing stays removed: no edit returns it to stock, and the facts the
-- removal rested on (project, unit type) can't change under it. Other corrections still work.
CREATE FUNCTION storage_unit_tested_removal_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.unit_type IS DISTINCT FROM OLD.unit_type
      OR NEW.project_id IS DISTINCT FROM OLD.project_id)
     AND EXISTS (SELECT 1 FROM tested_unit_removal WHERE storage_unit_id = OLD.id) THEN
    RAISE EXCEPTION 'storage unit % was removed after testing', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_tested_removal_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_tested_removal_final
  BEFORE UPDATE OF status, unit_type, project_id ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_tested_removal_is_final();

-- ---------------------------------------------------------------------------------------------
-- Action requests: in-app inbox, reassignment, preferences and email outbox (MM-T25, T26, T27, T29)
-- ---------------------------------------------------------------------------------------------
--
-- Routing (derived from real workflow policy, never from who is selected at a LAB station):
--   correction            → every Lab Manager (role-routed, shared)
--   cancellation_request  → every Lab Manager and the project's current Lead Project Engineer
--                           (shared)
--   closure_request       → the project's current Lead Project Engineer
--   retention_request     → every Lab Manager and the project's current Lead Project Engineer
-- A Lab Manager or admin may reassign an open item to one eligible person with a reason; the
-- item then goes to that person only. Every reassignment is an append-only row plus an audit
-- event. Resolution still happens only through the underlying workflow action (correction done,
-- test cancelled, program closed, retention request decided), which resolves the one shared item
-- for everyone. An item is opened once and resolved once, never deleted.
--
-- Email: people opt in (default off). Creating or reassigning an item writes one outbox row per
-- opted-in recipient; (action_item_id, recipient_user_id) is unique so retries never add a second.
-- Sending is behind EMAIL_ENABLED (refused until IT approves the sending configuration); tests
-- assert outbox rows and never send.

CREATE TABLE action_item (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL,
  target_role           text,
  target_user_id        uuid REFERENCES app_user (id),
  entity_type           text NOT NULL,
  entity_id             uuid NOT NULL,
  -- Null only for a retention request, which belongs to a project but no program.
  program_id            uuid REFERENCES lab_program (id),
  -- The review event that raised it (a return) and, once resolved, the one that resolved it.
  opened_by_event_id    uuid REFERENCES test_request_review_event (id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  resolved_at           timestamptz,
  resolved_by_user_id   uuid REFERENCES app_user (id),
  resolved_by_event_id  uuid REFERENCES test_request_review_event (id),
  -- Requests carry the requester's reason, their name and the retry key.
  reason                text CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_by_initials_snapshot text,
  created_by_name_snapshot     text,
  idempotency_key       uuid UNIQUE,
  request_hash          text,
  -- How it was resolved: the correction was done, the test cancelled, the program closed, or the
  -- retention request approved or declined.
  resolution            text,
  project_id            uuid NOT NULL REFERENCES project (id),
  assigned_user_id      uuid REFERENCES app_user (id),
  assigned_at           timestamptz,
  CONSTRAINT action_item_kind_check
    CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request')),
  CONSTRAINT action_item_target_role_check CHECK (target_role IN ('lab_manager')),
  CONSTRAINT action_item_entity_type_check
    CHECK (entity_type IN ('test_request', 'lab_program', 'retention_request')),
  CONSTRAINT action_item_target_check CHECK (target_role IS NOT NULL OR target_user_id IS NOT NULL),
  CONSTRAINT action_item_resolution_check CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolved_by_user_id IS NULL
     AND resolved_by_event_id IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  ),
  CONSTRAINT action_item_resolution_value_check
    CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined')),
  CONSTRAINT action_item_resolution_kind_check CHECK (
    resolution IS NULL OR status = 'resolved'
  ),
  CONSTRAINT action_item_shape_check CHECK (
    CASE kind
      WHEN 'correction' THEN entity_type = 'test_request' AND opened_by_event_id IS NOT NULL
        AND program_id IS NOT NULL
      WHEN 'cancellation_request' THEN entity_type = 'test_request' AND reason IS NOT NULL
        AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL AND program_id IS NOT NULL
      WHEN 'closure_request' THEN entity_type = 'lab_program' AND program_id IS NOT NULL
        AND entity_id = program_id AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
      WHEN 'retention_request' THEN entity_type = 'retention_request' AND program_id IS NULL
        AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT action_item_assignment_shape_check CHECK (
    (assigned_user_id IS NULL) = (assigned_at IS NULL)
  )
);
-- One outstanding correction per test.
CREATE UNIQUE INDEX action_item_open_correction_key
  ON action_item (entity_id) WHERE kind = 'correction' AND status = 'open';
-- One outstanding cancellation request per test and closure request per program.
CREATE UNIQUE INDEX action_item_open_request_key
  ON action_item (kind, entity_id) WHERE kind <> 'correction' AND status = 'open';
CREATE INDEX action_item_open_idx ON action_item (status, target_role, created_at);
CREATE INDEX action_item_program_idx ON action_item (program_id, created_at);
CREATE INDEX action_item_project_idx ON action_item (project_id, status);
CREATE INDEX action_item_assigned_idx ON action_item (assigned_user_id) WHERE status = 'open';

-- Producers name the program; the project follows from it, so the two can never disagree.
CREATE FUNCTION action_item_fill_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_project uuid;
BEGIN
  IF NEW.program_id IS NOT NULL THEN
    SELECT project_id INTO program_project FROM lab_program WHERE id = NEW.program_id;
    IF NEW.project_id IS NULL THEN
      NEW.project_id := program_project;
    ELSIF NEW.project_id <> program_project THEN
      RAISE EXCEPTION 'action item project doesn''t match its program'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'action_item_project_matches_program';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER action_item_fill_project
  BEFORE INSERT ON action_item
  FOR EACH ROW EXECUTE FUNCTION action_item_fill_project();

-- An item is resolved once; while open, only its assignment may change (through reassignment).
CREATE FUNCTION action_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action items can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open'
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_role IS DISTINCT FROM OLD.target_role
     OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.opened_by_event_id IS DISTINCT FROM OLD.opened_by_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by_name_snapshot IS DISTINCT FROM OLD.created_by_name_snapshot
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'action item % can only be resolved once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'resolved' THEN
    IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
      RAISE EXCEPTION 'action item % can''t be reassigned while it is resolved', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status = 'open' THEN
    -- Reassignment: a new assignee, never cleared.
    IF NEW.assigned_user_id IS NULL OR (NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id
                                        AND NEW.assigned_at IS NOT DISTINCT FROM OLD.assigned_at) THEN
      RAISE EXCEPTION 'action item % can only be resolved once', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER action_item_guard
  BEFORE UPDATE OR DELETE ON action_item
  FOR EACH ROW EXECUTE FUNCTION action_item_guard();

-- Reassignment history (append-only). The item row keeps only the current assignee.
CREATE TABLE action_item_assignment (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_item_id              uuid NOT NULL REFERENCES action_item (id),
  from_user_id                uuid REFERENCES app_user (id),
  to_user_id                  uuid NOT NULL REFERENCES app_user (id),
  to_name_snapshot            text NOT NULL,
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  assigned_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  assigned_by_initials_snapshot text,
  assigned_by_name_snapshot   text NOT NULL,
  assigned_at                 timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL
);
CREATE INDEX action_item_assignment_item_idx ON action_item_assignment (action_item_id, assigned_at);

CREATE TRIGGER action_item_assignment_append_only
  BEFORE UPDATE OR DELETE ON action_item_assignment
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Kinds whose decision belongs to the project's Lead Project Engineer (resolved at read time, so a
-- lead change on the project moves open requests to the new Lead Project Engineer).
CREATE FUNCTION action_item_routes_to_lead_project_engineer(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request', 'retention_request')
$$;

-- True when the item is in `uid`'s inbox: its assignee, or (unassigned) a holder of its target
-- role or the project's current Lead Project Engineer for lead-routed kinds. Account status/type
-- is checked by the caller; LAB never has an inbox.
CREATE FUNCTION action_item_routed_to(item_id uuid, uid uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN a.assigned_user_id IS NOT NULL THEN a.assigned_user_id = uid
    ELSE (a.target_role = 'lab_manager'
          AND EXISTS (SELECT 1 FROM role_assignment r WHERE r.user_id = uid AND r.role = 'lab_manager'))
      OR (action_item_routes_to_lead_project_engineer(a.kind) AND p.lead_project_engineer_user_id = uid)
      OR (NOT action_item_routes_to_lead_project_engineer(a.kind) AND a.target_user_id = uid)
  END
  FROM action_item a JOIN project p ON p.id = a.project_id
  WHERE a.id = item_id
$$;

-- Notification preferences (personal; email for action requests, default off).
CREATE TABLE notification_preference (
  user_id                 uuid PRIMARY KEY REFERENCES app_user (id),
  email_action_requests   boolean NOT NULL DEFAULT false,
  version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_item_id      uuid NOT NULL REFERENCES action_item (id),
  recipient_user_id   uuid NOT NULL REFERENCES app_user (id),
  to_address          text NOT NULL CHECK (length(to_address) BETWEEN 3 AND 320),
  subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  -- pending → sent | failed (attempts exhausted) | skipped (item resolved before sending).
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text CHECK (length(last_error) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  CONSTRAINT email_outbox_one_per_recipient UNIQUE (action_item_id, recipient_user_id),
  CONSTRAINT email_outbox_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Retention dates, holds, extensions and retention requests (MM-T29)
-- ---------------------------------------------------------------------------------------------
--
-- One calculation, used by inventory, detail screens and disposal: the unit_retention view.
-- Standard minimum retain-until = received date + 1 calendar year (PostgreSQL clamps a Feb 29
-- receipt to Feb 28). A unit is date-eligible ON its effective retain-until date (owner,
-- 2026-10-25): eligible_by_date(as_of) is `effective_retain_until <= as_of`, with as_of today in
-- the business time zone, passed by the API (tests inject it).
--
-- Holds and extensions are project-wide or selected-unit, always with a reason, set and released
-- by the project's Lead Project Engineer or a Lab Manager. A project-wide hold or extension covers
-- current and future units of the project until released. Rows are never deleted; release is
-- recorded once (who, when, why) and the row is otherwise immutable, so the rows themselves are
-- the history. A receipt-date correction changes received_date, and the view recomputes at once;
-- the old date stays in the correction history (MM-T13). Program closure never touches any of
-- this.
--
-- Tested-unit exception (MM-T36 owner amendments, 2026-10-27): a Shelby tube, or a bucket
-- explicitly holding a bulk soil sample (bulk_container in a bulk group), with completed-test
-- evidence linked to that exact unit (request not cancelled, same project) is retention-exempt.
-- Source, group membership, ALL coverage or a sibling's test never counts. The exemption is a
-- read-out only: holds and extensions keep covering the unit in history and keep covering every
-- other unit; nothing is released because one unit is exempt.
--
-- Requests: other internal users ask for a hold or extension (retention_request). The request
-- opens one action_item (kind retention_request) routed to the project's Lead Project Engineer and
-- every Lab Manager. Approving creates the hold/extension as the decider and resolves the item for
-- everyone; declining resolves it with a reason. Nothing changes until a decision.

CREATE TABLE retention_hold (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES project (id),
  scope                       text NOT NULL CHECK (scope IN ('project', 'units')),
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  placed_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  placed_by_initials_snapshot text,
  placed_by_name_snapshot     text NOT NULL,
  placed_at                   timestamptz NOT NULL DEFAULT now(),
  -- Set when it came from an approved request (retention_hold_request_fk below).
  request_id                  uuid,
  released_at                 timestamptz,
  released_by_user_id         uuid REFERENCES app_user (id),
  released_by_initials_snapshot text,
  released_by_name_snapshot   text,
  release_reason              text CHECK (length(btrim(release_reason)) BETWEEN 1 AND 2000),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  release_idempotency_key     uuid UNIQUE,
  release_request_hash        text,
  CONSTRAINT retention_hold_release_shape CHECK (
    (released_at IS NULL AND released_by_user_id IS NULL AND released_by_name_snapshot IS NULL
     AND release_reason IS NULL AND release_idempotency_key IS NULL)
    OR (released_at IS NOT NULL AND released_by_user_id IS NOT NULL
        AND released_by_name_snapshot IS NOT NULL AND release_reason IS NOT NULL
        AND release_idempotency_key IS NOT NULL AND release_request_hash IS NOT NULL)
  )
);
CREATE INDEX retention_hold_project_idx ON retention_hold (project_id) WHERE released_at IS NULL;

CREATE TABLE retention_hold_unit (
  hold_id          uuid NOT NULL REFERENCES retention_hold (id),
  storage_unit_id  uuid NOT NULL REFERENCES storage_unit (id),
  PRIMARY KEY (hold_id, storage_unit_id)
);
CREATE INDEX retention_hold_unit_unit_idx ON retention_hold_unit (storage_unit_id);

CREATE TABLE retention_extension (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES project (id),
  scope                       text NOT NULL CHECK (scope IN ('project', 'units')),
  -- Either a new retain-until date or a duration added to each unit's minimum.
  retain_until                date,
  extend_months               integer CHECK (extend_months BETWEEN 1 AND 600),
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  set_by_user_id              uuid NOT NULL REFERENCES app_user (id),
  set_by_initials_snapshot    text,
  set_by_name_snapshot        text NOT NULL,
  set_at                      timestamptz NOT NULL DEFAULT now(),
  -- Set when it came from an approved request (retention_extension_request_fk below).
  request_id                  uuid,
  released_at                 timestamptz,
  released_by_user_id         uuid REFERENCES app_user (id),
  released_by_initials_snapshot text,
  released_by_name_snapshot   text,
  release_reason              text CHECK (length(btrim(release_reason)) BETWEEN 1 AND 2000),
  version                     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  release_idempotency_key     uuid UNIQUE,
  release_request_hash        text,
  CONSTRAINT retention_extension_amount CHECK ((retain_until IS NULL) <> (extend_months IS NULL)),
  CONSTRAINT retention_extension_release_shape CHECK (
    (released_at IS NULL AND released_by_user_id IS NULL AND released_by_name_snapshot IS NULL
     AND release_reason IS NULL AND release_idempotency_key IS NULL)
    OR (released_at IS NOT NULL AND released_by_user_id IS NOT NULL
        AND released_by_name_snapshot IS NOT NULL AND release_reason IS NOT NULL
        AND release_idempotency_key IS NOT NULL AND release_request_hash IS NOT NULL)
  )
);
CREATE INDEX retention_extension_project_idx ON retention_extension (project_id)
  WHERE released_at IS NULL;

CREATE TABLE retention_extension_unit (
  extension_id     uuid NOT NULL REFERENCES retention_extension (id),
  storage_unit_id  uuid NOT NULL REFERENCES storage_unit (id),
  PRIMARY KEY (extension_id, storage_unit_id)
);
CREATE INDEX retention_extension_unit_unit_idx ON retention_extension_unit (storage_unit_id);

-- Selected units belong to the hold's/extension's project when chosen.
CREATE FUNCTION retention_scope_unit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_project uuid;
  unit_project uuid;
  parent_scope text;
BEGIN
  IF TG_TABLE_NAME = 'retention_hold_unit' THEN
    SELECT project_id, scope INTO owner_project, parent_scope FROM retention_hold WHERE id = NEW.hold_id;
  ELSE
    SELECT project_id, scope INTO owner_project, parent_scope
    FROM retention_extension WHERE id = NEW.extension_id;
  END IF;
  SELECT project_id INTO unit_project FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF parent_scope <> 'units' OR unit_project IS DISTINCT FROM owner_project THEN
    RAISE EXCEPTION 'retention scope unit % isn''t a selected unit of that project',
      NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retention_scope_unit_matches';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER retention_hold_unit_guard
  BEFORE INSERT ON retention_hold_unit
  FOR EACH ROW EXECUTE FUNCTION retention_scope_unit_guard();
CREATE TRIGGER retention_extension_unit_guard
  BEFORE INSERT ON retention_extension_unit
  FOR EACH ROW EXECUTE FUNCTION retention_scope_unit_guard();
CREATE TRIGGER retention_hold_unit_append_only
  BEFORE UPDATE OR DELETE ON retention_hold_unit
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();
CREATE TRIGGER retention_extension_unit_append_only
  BEFORE UPDATE OR DELETE ON retention_extension_unit
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Released once; nothing else ever changes, and nothing is deleted.
CREATE FUNCTION retention_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retention history can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR NEW.version <> OLD.version + 1
     OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by_user_id', 'released_by_initials_snapshot',
                               'released_by_name_snapshot', 'release_reason', 'version',
                               'release_idempotency_key', 'release_request_hash'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['released_at', 'released_by_user_id', 'released_by_initials_snapshot',
                               'released_by_name_snapshot', 'release_reason', 'version',
                               'release_idempotency_key', 'release_request_hash']) THEN
    RAISE EXCEPTION 'retention % can only be released once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER retention_hold_guard
  BEFORE UPDATE OR DELETE ON retention_hold
  FOR EACH ROW EXECUTE FUNCTION retention_decision_guard();
CREATE TRIGGER retention_extension_guard
  BEFORE UPDATE OR DELETE ON retention_extension
  FOR EACH ROW EXECUTE FUNCTION retention_decision_guard();

CREATE FUNCTION retention_minimum(received date) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  -- date + 1 year: Feb 29 → Feb 28 of the next year.
  SELECT (received + interval '1 year')::date
$$;

-- Exact-unit completed-test evidence for a Shelby tube or a bulk soil sample bucket. Never a
-- shared source, group, coverage or a sibling's test.
CREATE FUNCTION tested_unit_retention_exempt(unit_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM storage_unit su
    JOIN test_request_unit_link l ON l.storage_unit_id = su.id
    JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
    JOIN test_request r ON r.id = l.test_request_id
    JOIN lab_program lp ON lp.id = r.program_id
    WHERE su.id = unit_id
      AND (su.unit_type = 'shelby_tube'
           OR (su.unit_type = 'bulk_container' AND su.bulk_group_id IS NOT NULL))
      AND r.status <> 'cancelled'
      AND l.project_id = su.project_id AND lp.project_id = su.project_id
  ) OR EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = unit_id)
$$;

-- Active holds and extensions covering each unit.
CREATE VIEW unit_retention_hold AS
  SELECT su.id AS storage_unit_id, h.id AS hold_id
  FROM storage_unit su
  JOIN retention_hold h ON h.released_at IS NULL AND h.scope = 'project'
                       AND h.project_id = su.project_id
  UNION
  SELECT hu.storage_unit_id, h.id
  FROM retention_hold_unit hu
  JOIN retention_hold h ON h.id = hu.hold_id AND h.released_at IS NULL;

CREATE VIEW unit_retention_extension AS
  SELECT su.id AS storage_unit_id, e.id AS extension_id,
         coalesce(e.retain_until,
                  (retention_minimum(su.received_date) + make_interval(months => e.extend_months))::date)
           AS retain_until
  FROM storage_unit su
  JOIN retention_extension e ON e.released_at IS NULL AND e.scope = 'project'
                            AND e.project_id = su.project_id
  UNION
  SELECT su.id, e.id,
         coalesce(e.retain_until,
                  (retention_minimum(su.received_date) + make_interval(months => e.extend_months))::date)
  FROM retention_extension_unit eu
  JOIN retention_extension e ON e.id = eu.extension_id AND e.released_at IS NULL
  JOIN storage_unit su ON su.id = eu.storage_unit_id;

-- unit_retention: per unit, the standard minimum, the effective retain-until (never earlier than
-- the minimum), active holds and the tested-unit exemption. Callers compare
-- effective_retain_until <= today (business time zone) for "eligible by date".
CREATE VIEW unit_retention AS
  SELECT su.id AS storage_unit_id,
         su.project_id,
         su.received_date,
         retention_minimum(su.received_date) AS minimum_retain_until,
         greatest(retention_minimum(su.received_date),
                  (SELECT max(x.retain_until) FROM unit_retention_extension x
                   WHERE x.storage_unit_id = su.id)) AS effective_retain_until,
         (SELECT count(*)::int FROM unit_retention_hold x WHERE x.storage_unit_id = su.id)
           AS active_hold_count,
         (SELECT count(*)::int FROM unit_retention_extension x WHERE x.storage_unit_id = su.id)
           AS active_extension_count,
         tested_unit_retention_exempt(su.id) AS retention_exempt
  FROM storage_unit su;

CREATE TABLE retention_request (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES project (id),
  kind                        text NOT NULL CHECK (kind IN ('hold', 'extension')),
  scope                       text NOT NULL CHECK (scope IN ('project', 'units')),
  retain_until                date,
  extend_months               integer CHECK (extend_months BETWEEN 1 AND 600),
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_by_user_id        uuid NOT NULL REFERENCES app_user (id),
  requested_by_initials_snapshot text,
  requested_by_name_snapshot  text NOT NULL,
  requested_at                timestamptz NOT NULL DEFAULT now(),
  status                      text NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'approved', 'declined')),
  decided_at                  timestamptz,
  decided_by_user_id          uuid REFERENCES app_user (id),
  decided_by_name_snapshot    text,
  decision_reason             text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  hold_id                     uuid REFERENCES retention_hold (id),
  extension_id                uuid REFERENCES retention_extension (id),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL,
  decision_idempotency_key    uuid UNIQUE,
  decision_request_hash       text,
  CONSTRAINT retention_request_amount CHECK (
    (kind = 'hold' AND retain_until IS NULL AND extend_months IS NULL)
    OR (kind = 'extension' AND (retain_until IS NULL) <> (extend_months IS NULL))
  ),
  CONSTRAINT retention_request_decision_shape CHECK (
    (status = 'open' AND decided_at IS NULL AND decided_by_user_id IS NULL AND hold_id IS NULL
     AND extension_id IS NULL AND decision_idempotency_key IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND decision_idempotency_key IS NOT NULL
        AND ((kind = 'hold' AND hold_id IS NOT NULL AND extension_id IS NULL)
             OR (kind = 'extension' AND extension_id IS NOT NULL AND hold_id IS NULL)))
    OR (status = 'declined' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND decision_reason IS NOT NULL AND decision_idempotency_key IS NOT NULL
        AND hold_id IS NULL AND extension_id IS NULL)
  )
);
CREATE INDEX retention_request_project_idx ON retention_request (project_id, status);

CREATE TABLE retention_request_unit (
  request_id       uuid NOT NULL REFERENCES retention_request (id),
  storage_unit_id  uuid NOT NULL REFERENCES storage_unit (id),
  PRIMARY KEY (request_id, storage_unit_id)
);
CREATE TRIGGER retention_request_unit_append_only
  BEFORE UPDATE OR DELETE ON retention_request_unit
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Holds and extensions name the request they came from (the two tables refer to each other).
ALTER TABLE retention_hold ADD CONSTRAINT retention_hold_request_fk
  FOREIGN KEY (request_id) REFERENCES retention_request (id);
ALTER TABLE retention_extension ADD CONSTRAINT retention_extension_request_fk
  FOREIGN KEY (request_id) REFERENCES retention_request (id);

-- A request is decided once; nothing else changes.
CREATE FUNCTION retention_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retention requests can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_at', 'decided_by_user_id', 'decided_by_name_snapshot',
                               'decision_reason', 'hold_id', 'extension_id',
                               'decision_idempotency_key', 'decision_request_hash'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'decided_at', 'decided_by_user_id', 'decided_by_name_snapshot',
                               'decision_reason', 'hold_id', 'extension_id',
                               'decision_idempotency_key', 'decision_request_hash']) THEN
    RAISE EXCEPTION 'retention request % can only be decided once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER retention_request_guard
  BEFORE UPDATE OR DELETE ON retention_request
  FOR EACH ROW EXECUTE FUNCTION retention_request_guard();

-- ---------------------------------------------------------------------------------------------
-- Whole-unit disposal approval and online removal: the standard route (MM-T30, T70, T77)
-- ---------------------------------------------------------------------------------------------
--
-- Standard eligibility (unit_disposal_eligible): the unit is in stock, its effective retain-until
-- (unit_retention) has been reached, no active hold covers it, and no lab program that covers it
-- is still open. Covering uses the existing rules: a not-closed program that froze the unit into
-- coverage, chose it on a draft line, names it as a standalone source, linked it as tested, or has
-- a line on a test hole the unit belongs to (a summary for the hole, a tube sourced from it, or a
-- bucket of a bulk group sourced from it), so a later receipt on an open program's hole is covered
-- too.
--
-- Approval (Lead Project Engineer of the project or Lab Manager) sets status
-- approved_for_disposal and records who and when; it never disposes. An approval is valid only
-- for the project it was granted under (MM-T70, D19): a unit's project can't change while it has
-- a live approval (revoke first, then correct; 422 disposal_approval_live in the API), and the new
-- project's Lead Project Engineer or a Lab Manager approves again. Revoking (same people, reason)
-- returns the unit to in_stock. Removal is a separate, online-only scan by a personal account: it
-- locks the unit, requires an active approval under the unit's current project and rechecks
-- eligibility (holds placed after approval block it), then records the disposition, actor, time
-- and last location atomically. The location row stays as history; a disposed unit no longer
-- occupies it or counts as current stock.
--
-- The post-testing route (tested_unit_removal) stays separate and needs none of this. Once
-- disposed by either route, a unit never returns to stock and never gets a fresh sticker.

-- A disposed unit stays disposed, whichever route disposed it.
CREATE FUNCTION storage_unit_disposed_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A unit removed after testing is guarded by storage_unit_tested_removal_final (MM-T36).
  IF OLD.status = 'disposed' AND NEW.status IS DISTINCT FROM 'disposed'
     AND NOT EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = OLD.id) THEN
    RAISE EXCEPTION 'storage unit % is disposed', OLD.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_disposed_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_disposed_final
  BEFORE UPDATE OF status ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_disposed_is_final();

CREATE FUNCTION unit_open_covering_programs(unit_id uuid)
RETURNS TABLE (program_id uuid, program_number text)
LANGUAGE sql STABLE AS $$
  SELECT lp.id, lp.program_number
  FROM lab_program lp
  JOIN storage_unit su ON su.id = unit_id AND su.project_id = lp.project_id
  WHERE lp.status <> 'closed'
    AND (EXISTS (SELECT 1 FROM program_scope_snapshot s
                 WHERE s.program_id = lp.id AND s.storage_unit_id = su.id AND s.included)
         OR EXISTS (SELECT 1 FROM test_line_unit_choice c JOIN test_line l ON l.id = c.line_id
                    WHERE l.program_id = lp.id AND c.storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_bulk_group_id = su.bulk_group_id)
         OR EXISTS (SELECT 1 FROM test_request_unit_link t JOIN test_request r ON r.id = t.test_request_id
                    WHERE r.program_id = lp.id AND t.storage_unit_id = su.id)
         OR EXISTS (SELECT 1 FROM test_line l
                    WHERE l.program_id = lp.id AND l.source_kind = 'test_hole'
                      AND (EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                                   WHERE h.storage_unit_id = su.id AND h.test_hole_id = l.test_hole_id)
                           OR su.source_test_hole_id = l.test_hole_id
                           OR EXISTS (SELECT 1 FROM bulk_group g
                                      WHERE g.id = su.bulk_group_id
                                        AND g.test_hole_id = l.test_hole_id))))
$$;

-- Standard disposal eligibility as of `as_of` (today in the business time zone). `allow_approved`
-- lets removal recheck a unit that is already approved.
CREATE FUNCTION unit_disposal_eligible(unit_id uuid, as_of date, allow_approved boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (su.status = 'in_stock' OR (allow_approved AND su.status = 'approved_for_disposal'))
         AND ur.effective_retain_until <= as_of
         AND ur.active_hold_count = 0
         AND NOT EXISTS (SELECT 1 FROM unit_open_covering_programs(su.id))
         -- Where the unit actually is must be settled first (MM-T28, D29).
         AND NOT EXISTS (SELECT 1 FROM location_conflict c
                         WHERE c.storage_unit_id = su.id AND c.status = 'open')
  FROM storage_unit su JOIN unit_retention ur ON ur.storage_unit_id = su.id
  WHERE su.id = unit_id
$$;

CREATE TABLE disposal_approval (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_unit_id             uuid NOT NULL REFERENCES storage_unit (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  -- Units approved together share a batch.
  batch_id                    uuid NOT NULL,
  approved_by_user_id         uuid NOT NULL REFERENCES app_user (id),
  approved_by_initials_snapshot text,
  approved_by_name_snapshot   text NOT NULL,
  approved_at                 timestamptz NOT NULL DEFAULT now(),
  -- Retain-until it was approved against (history).
  effective_retain_until      date NOT NULL,
  revoked_at                  timestamptz,
  revoked_by_user_id          uuid REFERENCES app_user (id),
  revoked_by_name_snapshot    text,
  revoke_reason               text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  -- Set when the unit is removed under this approval.
  used_at                     timestamptz,
  idempotency_key             uuid NOT NULL,
  request_hash                text NOT NULL,
  revoke_idempotency_key      uuid UNIQUE,
  CONSTRAINT disposal_approval_batch_unit UNIQUE (idempotency_key, storage_unit_id),
  CONSTRAINT disposal_approval_state CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL
     AND revoke_idempotency_key IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoke_idempotency_key IS NOT NULL AND used_at IS NULL)
  )
);
-- At most one live (not revoked) approval per unit.
CREATE UNIQUE INDEX disposal_approval_live_key ON disposal_approval (storage_unit_id)
  WHERE revoked_at IS NULL;
CREATE INDEX disposal_approval_project_idx ON disposal_approval (project_id, approved_at);

-- Revoked or used once; nothing else changes; never deleted.
CREATE FUNCTION disposal_approval_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disposal approvals can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR OLD.used_at IS NOT NULL
     OR (NEW.revoked_at IS NULL AND NEW.used_at IS NULL)
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by_user_id', 'revoked_by_name_snapshot',
                               'revoke_reason', 'used_at', 'revoke_idempotency_key'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by_user_id', 'revoked_by_name_snapshot',
                               'revoke_reason', 'used_at', 'revoke_idempotency_key']) THEN
    RAISE EXCEPTION 'disposal approval % can only be revoked or used once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_approval_guard
  BEFORE UPDATE OR DELETE ON disposal_approval
  FOR EACH ROW EXECUTE FUNCTION disposal_approval_guard();

-- A new approval must name the unit's current project.
CREATE FUNCTION disposal_approval_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage_unit su
                 WHERE su.id = NEW.storage_unit_id AND su.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a disposal approval must be under the unit''s current project'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_approval_matches_unit_project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_approval_project_guard
  BEFORE INSERT ON disposal_approval
  FOR EACH ROW EXECUTE FUNCTION disposal_approval_project_guard();

-- A unit's project can't change while it has a live (not revoked, not used) disposal approval
-- (MM-T70, owner decision 2026-10-28: refuse).
CREATE FUNCTION storage_unit_project_needs_no_live_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM disposal_approval a
             WHERE a.storage_unit_id = NEW.id AND a.revoked_at IS NULL AND a.used_at IS NULL) THEN
    RAISE EXCEPTION 'storage unit % is approved for disposal: revoke the approval before changing its project',
      NEW.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_project_disposal_approval_live';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_project_needs_no_live_approval
  BEFORE UPDATE OF project_id ON storage_unit
  FOR EACH ROW
  WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION storage_unit_project_needs_no_live_approval();

CREATE TABLE disposal_removal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One disposition per physical unit, ever.
  storage_unit_id             uuid NOT NULL UNIQUE REFERENCES storage_unit (id),
  approval_id                 uuid NOT NULL UNIQUE REFERENCES disposal_approval (id),
  project_id                  uuid NOT NULL REFERENCES project (id),
  unit_readable_id_snapshot   text NOT NULL,
  location_id                 uuid NOT NULL REFERENCES location (id),
  location_code_snapshot      text NOT NULL,
  location_name_snapshot      text NOT NULL,
  removed_by_user_id          uuid NOT NULL REFERENCES app_user (id),
  removed_by_account_type     text NOT NULL CHECK (removed_by_account_type IN ('personal', 'test')),
  removed_by_initials_snapshot text,
  removed_by_name_snapshot    text NOT NULL,
  removed_at                  timestamptz NOT NULL DEFAULT now(),
  idempotency_key             uuid NOT NULL UNIQUE,
  request_hash                text NOT NULL
);
CREATE INDEX disposal_removal_project_idx ON disposal_removal (project_id, removed_at);

CREATE TRIGGER disposal_removal_append_only
  BEFORE UPDATE OR DELETE ON disposal_removal
  FOR EACH ROW EXECUTE FUNCTION lab_append_only();

-- Written after the unit update in the removal transaction: the unit is disposed, at the
-- recorded location, under an approval granted under its current project (used now), and has no
-- post-testing removal.
CREATE FUNCTION disposal_removal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit storage_unit%ROWTYPE;
BEGIN
  SELECT * INTO unit FROM storage_unit WHERE id = NEW.storage_unit_id;
  IF unit.status <> 'disposed' OR unit.project_id <> NEW.project_id
     OR unit.current_location_id <> NEW.location_id
     OR NOT EXISTS (SELECT 1 FROM disposal_approval a
                    WHERE a.id = NEW.approval_id AND a.storage_unit_id = NEW.storage_unit_id
                      AND a.project_id = unit.project_id
                      AND a.revoked_at IS NULL AND a.used_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM tested_unit_removal t WHERE t.storage_unit_id = NEW.storage_unit_id) THEN
    RAISE EXCEPTION 'disposal of % doesn''t match the unit and its approval', unit.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'disposal_removal_matches_unit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disposal_removal_guard
  BEFORE INSERT ON disposal_removal
  FOR EACH ROW EXECUTE FUNCTION disposal_removal_guard();

-- A disposed storage unit's ID never gets a fresh sticker (MM-T77). The API refuses such a
-- request (422 storage_unit_disposed, nothing queued); this is the backstop for any other writer.
-- The unit's row is share-locked so a concurrent disposal (which locks the unit FOR UPDATE)
-- either waits for the job or is seen by it. Print history for a unit disposed later is untouched
-- and stays readable: only new items are checked, and only for a job requested at or after the
-- disposal (both disposal routes record disposed_at), so history from before a disposal can still
-- be loaded, e.g. by imports and the benchmark generator.
CREATE FUNCTION print_job_item_not_disposed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unit_status text;
  unit_disposed_at timestamptz;
  job_created_at timestamptz;
BEGIN
  SELECT status, disposed_at INTO unit_status, unit_disposed_at
  FROM storage_unit WHERE id = NEW.storage_unit_id FOR SHARE;
  SELECT created_at INTO job_created_at FROM print_job WHERE id = NEW.print_job_id;
  IF unit_status = 'disposed' AND unit_disposed_at IS NOT NULL
     AND job_created_at >= unit_disposed_at THEN
    RAISE EXCEPTION 'storage unit % is disposed; no label is printed for it', NEW.storage_unit_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'print_job_item_not_disposed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_job_item_not_disposed
  BEFORE INSERT ON print_job_item
  FOR EACH ROW EXECUTE FUNCTION print_job_item_not_disposed();

-- ---------------------------------------------------------------------------------------------
-- Project assignments and scoped grants (MM-AO02; owner decisions D01–D16, 2026-10-29)
-- ---------------------------------------------------------------------------------------------
--
-- Storage only. Who may write these rows, and what each one lets a person do, is the central
-- server policy's job (MM-AO03); nothing here is read by an authorization check yet. The rules
-- that hold whatever the policy says are enforced here:
--   * every row names a stable person (app_user.id) with name/initials snapshots of the person and
--     of whoever recorded it, so renames never rewrite history;
--   * history is append-only: a row is never deleted, and the only change it ever takes is its one
--     ending (revocation, removal or decision), recorded with who, when and why;
--   * at most one active row per person and scope, so repeated grants can't stack;
--   * new grants, revocations and appointments carry a reason (D15);
--   * the shared LAB account never holds an assignment or grant.
-- Job titles, positions, notification recipients and the LAB station's selected person are never
-- an authority source, and none of these rows is derived from them (D16, AC3).
--
-- What stays where it was:
--   * project.lead_project_engineer_user_id is the one effective Lead Project Engineer (D03); an
--     admin changes it with a reason. Nominations below are suggestions, never authority (D01).
--   * acceptance_delegation is the only acceptance-delegate store (reused, not duplicated).
--   * project.review_engineer_user_id keeps routing "Only mine" until MM-AO03/AO06 switch that
--     read to project_reviewer_assignment (D12); it never implies reviewer eligibility or issuer
--     authority, and no assignment or grant is backfilled from it.
--   * The Lead Project Engineer's own report issuance on their project needs no grant row (D07).
--   * Concrete Lab Manager grants (D13) are deferred to the concrete integration (C02/AO08).

-- Workflow / report-type scopes for reviewer eligibility, reviewer assignments and report issuer
-- grants (D05, D06). Reference data: rows are retired, never deleted; add scopes with a migration.
-- Generic lab review is not scoped and stays open to active personal users.
CREATE TABLE review_scope (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO review_scope (code, label, sort_order) VALUES
  ('concrete_field', 'Concrete field reports', 1),
  ('concrete_strength', 'Concrete strength reports', 2);

CREATE TRIGGER review_scope_no_delete BEFORE DELETE ON review_scope
  FOR EACH ROW EXECUTE FUNCTION lab_catalogue_no_delete();

-- History rows take exactly one change: their ending. TG_ARGV names the columns that ending sets,
-- the first being its timestamp (null while the row is active).
CREATE FUNCTION assignment_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows can''t be deleted', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF to_jsonb(OLD) ->> TG_ARGV[0] IS NOT NULL THEN
    RAISE EXCEPTION '% % has already ended', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF to_jsonb(NEW) ->> TG_ARGV[0] IS NULL
     OR (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION '% % can only be ended once; nothing else changes', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The person named by column TG_ARGV[0] is not the shared LAB account.
CREATE FUNCTION assignment_subject_is_personal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user
             WHERE id = (to_jsonb(NEW) ->> TG_ARGV[0])::uuid AND account_type = 'shared_lab') THEN
    RAISE EXCEPTION 'the shared LAB account can''t hold a project assignment or grant'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assignment_subject_is_personal';
  END IF;
  RETURN NEW;
END;
$$;

-- D01: "Can create and lead projects", an explicitly administered staff capability that lets its
-- holder appoint themselves Lead Project Engineer, only when creating a project. Never derived
-- from a job title; grants no issuer or acceptance authority.
CREATE TABLE staff_capability_grant (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       uuid NOT NULL REFERENCES app_user (id),
  user_initials_snapshot        text,
  user_name_snapshot            text NOT NULL,
  capability                    text NOT NULL CHECK (capability IN ('project.create_and_lead')),
  granted_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot  text,
  granted_by_name_snapshot      text NOT NULL,
  granted_at                    timestamptz NOT NULL DEFAULT now(),
  grant_reason                  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  grant_idempotency_key         uuid NOT NULL UNIQUE,
  grant_request_hash            text NOT NULL,
  revoked_at                    timestamptz,
  revoked_by_user_id            uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot  text,
  revoked_by_name_snapshot      text,
  revoke_reason                 text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT staff_capability_grant_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX staff_capability_grant_active_key
  ON staff_capability_grant (user_id, capability) WHERE revoked_at IS NULL;

CREATE TRIGGER staff_capability_grant_history
  BEFORE UPDATE OR DELETE ON staff_capability_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason');
CREATE TRIGGER staff_capability_grant_personal
  BEFORE INSERT ON staff_capability_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('user_id');

-- D01: the creator nominates a Lead Project Engineer and an admin confirms (the appointment, with
-- a reason) or rejects; the nominator may withdraw. A pending nomination powers nothing: the
-- effective lead is project.lead_project_engineer_user_id, which confirmation sets in the same
-- transaction (MM-AO04). At most one pending nomination per project.
CREATE TABLE project_lead_nomination (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                     uuid NOT NULL REFERENCES project (id),
  nominee_user_id                uuid NOT NULL REFERENCES app_user (id),
  nominee_initials_snapshot      text,
  nominee_name_snapshot          text NOT NULL,
  nominated_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  nominated_by_initials_snapshot text,
  nominated_by_name_snapshot     text NOT NULL,
  nominated_at                   timestamptz NOT NULL DEFAULT now(),
  nomination_note                text CHECK (length(btrim(nomination_note)) BETWEEN 1 AND 2000),
  nomination_idempotency_key     uuid NOT NULL UNIQUE,
  nomination_request_hash        text NOT NULL,
  status                         text NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'confirmed', 'rejected', 'withdrawn')),
  decided_at                     timestamptz,
  decided_by_user_id             uuid REFERENCES app_user (id),
  decided_by_initials_snapshot   text,
  decided_by_name_snapshot       text,
  decision_reason                text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT project_lead_nomination_decision_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL
     AND decided_by_initials_snapshot IS NULL AND decided_by_name_snapshot IS NULL
     AND decision_reason IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
        AND decided_by_name_snapshot IS NOT NULL AND decision_reason IS NOT NULL
        AND decided_at >= nominated_at)
  )
);
CREATE UNIQUE INDEX project_lead_nomination_pending_key
  ON project_lead_nomination (project_id) WHERE status = 'pending';
CREATE INDEX project_lead_nomination_project_idx
  ON project_lead_nomination (project_id, nominated_at);

CREATE TRIGGER project_lead_nomination_history
  BEFORE UPDATE OR DELETE ON project_lead_nomination
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'decided_at', 'status', 'decided_by_user_id', 'decided_by_initials_snapshot',
    'decided_by_name_snapshot', 'decision_reason');
CREATE TRIGGER project_lead_nomination_personal
  BEFORE INSERT ON project_lead_nomination
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('nominee_user_id');

-- D04: the project's working team of Supporting Engineers and other participating staff. Managed
-- by the Lead Project Engineer or an admin; membership grants no review, acceptance, issuance or
-- any other controlled authority, and no visibility restriction (broad internal visibility stays).
CREATE TABLE project_team_member (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  user_id                       uuid NOT NULL REFERENCES app_user (id),
  user_initials_snapshot        text,
  user_name_snapshot            text NOT NULL,
  added_by_user_id              uuid NOT NULL REFERENCES app_user (id),
  added_by_initials_snapshot    text,
  added_by_name_snapshot        text NOT NULL,
  added_at                      timestamptz NOT NULL DEFAULT now(),
  add_reason                    text NOT NULL CHECK (length(btrim(add_reason)) BETWEEN 1 AND 2000),
  add_idempotency_key           uuid NOT NULL UNIQUE,
  add_request_hash              text NOT NULL,
  removed_at                    timestamptz,
  removed_by_user_id            uuid REFERENCES app_user (id),
  removed_by_initials_snapshot  text,
  removed_by_name_snapshot      text,
  remove_reason                 text CHECK (length(btrim(remove_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT project_team_member_removed_check CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_by_name_snapshot IS NULL
     AND removed_by_initials_snapshot IS NULL AND remove_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL
        AND removed_by_name_snapshot IS NOT NULL AND remove_reason IS NOT NULL
        AND removed_at >= added_at)
  )
);
CREATE UNIQUE INDEX project_team_member_active_key
  ON project_team_member (project_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX project_team_member_user_idx ON project_team_member (user_id) WHERE removed_at IS NULL;
CREATE INDEX project_team_member_project_idx ON project_team_member (project_id, added_at);

CREATE TRIGGER project_team_member_history
  BEFORE UPDATE OR DELETE ON project_team_member
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'removed_at', 'removed_by_user_id', 'removed_by_initials_snapshot', 'removed_by_name_snapshot',
    'remove_reason');
CREATE TRIGGER project_team_member_personal
  BEFORE INSERT ON project_team_member
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('user_id');

-- D05: administrator-managed reviewer eligibility, per workflow / report-type scope. It is what
-- makes a person assignable as a scoped reviewer; it is not a review assignment itself.
CREATE TABLE reviewer_eligibility (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       uuid NOT NULL REFERENCES app_user (id),
  user_initials_snapshot        text,
  user_name_snapshot            text NOT NULL,
  scope_code                    text NOT NULL REFERENCES review_scope (code),
  granted_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot  text,
  granted_by_name_snapshot      text NOT NULL,
  granted_at                    timestamptz NOT NULL DEFAULT now(),
  grant_reason                  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  grant_idempotency_key         uuid NOT NULL UNIQUE,
  grant_request_hash            text NOT NULL,
  revoked_at                    timestamptz,
  revoked_by_user_id            uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot  text,
  revoked_by_name_snapshot      text,
  revoke_reason                 text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT reviewer_eligibility_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX reviewer_eligibility_active_key
  ON reviewer_eligibility (user_id, scope_code) WHERE revoked_at IS NULL;

CREATE TRIGGER reviewer_eligibility_history
  BEFORE UPDATE OR DELETE ON reviewer_eligibility
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason');
CREATE TRIGGER reviewer_eligibility_personal
  BEFORE INSERT ON reviewer_eligibility
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('user_id');

-- D04/D05: scoped review responsibility on a project; many reviewers per project, and a person
-- may hold several scopes. Assigned by the Lead Project Engineer or an admin to an eligible person
-- (eligibility is checked by the policy at assignment time). Routes review work; grants no
-- acceptance, issuance or unrelated approval.
CREATE TABLE project_reviewer_assignment (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  reviewer_user_id              uuid NOT NULL REFERENCES app_user (id),
  reviewer_initials_snapshot    text,
  reviewer_name_snapshot        text NOT NULL,
  scope_code                    text NOT NULL REFERENCES review_scope (code),
  assigned_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  assigned_by_initials_snapshot text,
  assigned_by_name_snapshot     text NOT NULL,
  assigned_at                   timestamptz NOT NULL DEFAULT now(),
  assign_reason                 text NOT NULL CHECK (length(btrim(assign_reason)) BETWEEN 1 AND 2000),
  assign_idempotency_key        uuid NOT NULL UNIQUE,
  assign_request_hash           text NOT NULL,
  removed_at                    timestamptz,
  removed_by_user_id            uuid REFERENCES app_user (id),
  removed_by_initials_snapshot  text,
  removed_by_name_snapshot      text,
  remove_reason                 text CHECK (length(btrim(remove_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT project_reviewer_assignment_removed_check CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_by_name_snapshot IS NULL
     AND removed_by_initials_snapshot IS NULL AND remove_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL
        AND removed_by_name_snapshot IS NOT NULL AND remove_reason IS NOT NULL
        AND removed_at >= assigned_at)
  )
);
CREATE UNIQUE INDEX project_reviewer_assignment_active_key
  ON project_reviewer_assignment (project_id, reviewer_user_id, scope_code) WHERE removed_at IS NULL;
CREATE INDEX project_reviewer_assignment_user_idx
  ON project_reviewer_assignment (reviewer_user_id) WHERE removed_at IS NULL;
CREATE INDEX project_reviewer_assignment_project_idx
  ON project_reviewer_assignment (project_id, assigned_at);

CREATE TRIGGER project_reviewer_assignment_history
  BEFORE UPDATE OR DELETE ON project_reviewer_assignment
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'removed_at', 'removed_by_user_id', 'removed_by_initials_snapshot', 'removed_by_name_snapshot',
    'remove_reason');
CREATE TRIGGER project_reviewer_assignment_personal
  BEFORE INSERT ON project_reviewer_assignment
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('reviewer_user_id');

-- D06/D07: Authorized report issuer for one project and report scope, granted and revoked by the
-- project's Lead Project Engineer (fields approved by Kyle, 2026-10-29). Administrator status
-- grants nothing here, and the lead's own issuance needs no row. A grant is usable only while not
-- revoked and before its optional expiry. Emergency suspension is a revocation of kind
-- 'emergency'; a new grant restores authority. Renewing an expired grant revokes it first, so one
-- grant per project, person and scope is ever active.
CREATE TABLE project_report_issuer_grant (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  issuer_user_id                uuid NOT NULL REFERENCES app_user (id),
  issuer_initials_snapshot      text,
  issuer_name_snapshot          text NOT NULL,
  report_scope_code             text NOT NULL REFERENCES review_scope (code),
  granted_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  granted_by_initials_snapshot  text,
  granted_by_name_snapshot      text NOT NULL,
  granted_at                    timestamptz NOT NULL DEFAULT now(),
  grant_reason                  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 2000),
  -- The firm's approval document or reference, when there is one (never invented).
  approval_reference            text CHECK (approval_reference = btrim(approval_reference)
                                            AND length(approval_reference) BETWEEN 1 AND 200),
  expires_at                    timestamptz,
  grant_idempotency_key         uuid NOT NULL UNIQUE,
  grant_request_hash            text NOT NULL,
  revoked_at                    timestamptz,
  revoked_by_user_id            uuid REFERENCES app_user (id),
  revoked_by_initials_snapshot  text,
  revoked_by_name_snapshot      text,
  revoke_reason                 text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 2000),
  revocation_kind               text CHECK (revocation_kind IN ('ordinary', 'emergency')),
  CONSTRAINT project_report_issuer_grant_expiry_check CHECK (expires_at > granted_at),
  CONSTRAINT project_report_issuer_grant_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL AND revocation_kind IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revocation_kind IS NOT NULL AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX project_report_issuer_grant_active_key
  ON project_report_issuer_grant (project_id, issuer_user_id, report_scope_code)
  WHERE revoked_at IS NULL;
CREATE INDEX project_report_issuer_grant_user_idx
  ON project_report_issuer_grant (issuer_user_id) WHERE revoked_at IS NULL;
CREATE INDEX project_report_issuer_grant_project_idx
  ON project_report_issuer_grant (project_id, granted_at);

CREATE TRIGGER project_report_issuer_grant_history
  BEFORE UPDATE OR DELETE ON project_report_issuer_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason', 'revocation_kind');
CREATE TRIGGER project_report_issuer_grant_personal
  BEFORE INSERT ON project_report_issuer_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('issuer_user_id');
