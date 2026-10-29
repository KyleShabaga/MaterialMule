-- TRP-T02: receiving data model.
-- Integrity rules live here (FKs, checks, unique indexes) so invalid states can't be stored even
-- if application code has a bug. No individual sample table: receiving is per storage unit.
-- Enumerations are text + CHECK rather than PostgreSQL enum types so later migrations can extend
-- them without ALTER TYPE.

-- ---------------------------------------------------------------------------------------------
-- People, identities, roles and sessions
-- ---------------------------------------------------------------------------------------------

CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  given_name         text CHECK (length(given_name) <= 100),
  surname            text CHECK (length(surname) <= 100),
  work_email         text CHECK (length(work_email) <= 320),
  sign_in_username   text CHECK (length(sign_in_username) <= 320),
  -- Official initials are confirmed by an admin; they are not unique (two "JS" staff can exist).
  official_initials  text CHECK (official_initials ~ '^[A-Z]{1,5}$'),
  position           text CHECK (position IN ('technician', 'engineer', 'project_engineer', 'lab_manager')),
  account_type       text NOT NULL CHECK (account_type IN ('personal', 'shared_lab', 'test')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'disabled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id),
  provider    text NOT NULL CHECK (provider IN ('microsoft', 'local_lab', 'test')),
  -- Empty string for providers without tenants so the unique constraint below always applies.
  tenant_id   text NOT NULL DEFAULT '',
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_link_provider_subject_key UNIQUE (provider, tenant_id, subject)
);
CREATE INDEX identity_link_user_idx ON identity_link (user_id);

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

-- ---------------------------------------------------------------------------------------------
-- Projects and test holes
-- ---------------------------------------------------------------------------------------------

CREATE TABLE project (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored exactly as entered once trimmed; uniqueness ignores case.
  project_number            text NOT NULL
                              CHECK (project_number = btrim(project_number)
                                     AND length(project_number) BETWEEN 1 AND 40),
  project_number_normalized text GENERATED ALWAYS AS (lower(project_number)) STORED,
  name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  client                    text NOT NULL CHECK (length(btrim(client)) BETWEEN 1 AND 200),
  lead_project_engineer_user_id             uuid NOT NULL REFERENCES app_user (id),
  review_engineer_user_id   uuid REFERENCES app_user (id),
  server_folder_path        text CHECK (length(server_folder_path) <= 500),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   integer NOT NULL DEFAULT 1,
  CONSTRAINT project_number_key UNIQUE (project_number_normalized)
);
CREATE INDEX project_name_lower_idx ON project (lower(name));

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

-- ---------------------------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------------------------

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
  CONSTRAINT location_code_key UNIQUE (code_normalized),
  -- A system location (Receiving lab) can never be retired.
  CHECK (NOT is_system OR active)
);

-- ---------------------------------------------------------------------------------------------
-- Receipts and storage units
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

-- One counter per prefix and issuance year (T03 allocates from it).
CREATE TABLE storage_unit_annual_counter (
  prefix      text NOT NULL CHECK (prefix IN ('CT', 'BKT', 'ST', 'CRE')),
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_value  integer NOT NULL DEFAULT 0 CHECK (last_value BETWEEN 0 AND 999999),
  PRIMARY KEY (prefix, year)
);

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
  CONSTRAINT storage_unit_project_id_key UNIQUE (project_id, id),
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
  )
);
CREATE INDEX storage_unit_project_status_idx ON storage_unit (project_id, status);
CREATE INDEX storage_unit_location_idx ON storage_unit (current_location_id, status);
CREATE INDEX storage_unit_receipt_idx ON storage_unit (receipt_id);
CREATE INDEX storage_unit_received_date_idx ON storage_unit (received_date);

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

-- ---------------------------------------------------------------------------------------------
-- Audit and printing (behaviour arrives in T03 and T15)
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
  request_id               text
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_event_action_idx ON audit_event (action, occurred_at DESC);

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
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX print_job_status_idx ON print_job (status, created_at);

CREATE TABLE print_job_item (
  print_job_id     uuid NOT NULL REFERENCES print_job (id),
  storage_unit_id  uuid NOT NULL REFERENCES storage_unit (id),
  position         integer NOT NULL CHECK (position >= 1),
  PRIMARY KEY (print_job_id, storage_unit_id),
  UNIQUE (print_job_id, position)
);
CREATE INDEX print_job_item_unit_idx ON print_job_item (storage_unit_id);
