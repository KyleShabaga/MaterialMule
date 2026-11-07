-- MM-V2-C02: per-project concrete settings and the concrete Lab Manager grant (D13).
--
-- Settings are defaults for specimen sets created later. Nothing here touches concrete_field_report,
-- concrete_specimen_set or concrete_specimen: changing a default never rewrites an existing
-- schedule, assignment or issued report (AC3). Reviewers are not stored here: concrete reviewers
-- are project_reviewer_assignment rows for the concrete_field / concrete_strength scopes (MISC-08).
--
-- A project has no settings row until someone first saves its settings; until then the API reads
-- the column defaults below (packages/shared CONCRETE_SETTINGS_DEFAULTS, proven equal in
-- schema-concrete-settings.test.ts). So this migration changes no existing row.

-- Each default specimen age is a number of days from casting (1-999) or HOLD; one entry per
-- specimen in a default set, so at most 26 (letters A-Z, as concrete_specimen.letter).
CREATE FUNCTION concrete_specimen_ages_valid(ages text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT array_ndims(ages) = 1
       AND cardinality(ages) BETWEEN 1 AND 26
       AND NOT EXISTS (
         SELECT 1 FROM unnest(ages) AS age
         WHERE age IS NULL OR age !~ '^(HOLD|[1-9][0-9]{0,2})$'
       )
  $$;

CREATE TABLE concrete_project_settings (
  project_id                    uuid PRIMARY KEY REFERENCES project (id),
  -- Confirmed by Kyle (combined plan, Settings): 7 / 28 / 28 / HOLD.
  default_specimen_ages         text[] NOT NULL DEFAULT '{7,28,28,HOLD}'
                                  CONSTRAINT concrete_project_settings_ages_check
                                  CHECK (concrete_specimen_ages_valid(default_specimen_ages)),
  -- Confirmed: HOLD lasts 56 days from casting unless the project sets another number of days.
  hold_duration_days            integer NOT NULL DEFAULT 56
                                  CONSTRAINT concrete_project_settings_hold_check
                                  CHECK (hold_duration_days BETWEEN 1 AND 999),
  -- Include the testing machine's make/model and calibration dates on issued reports. NULL means
  -- not chosen yet: the default awaits report-template mapping (never guessed).
  include_machine_info          boolean,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  updated_by_initials_snapshot  text,
  updated_by_name_snapshot      text NOT NULL,
  version                       integer NOT NULL DEFAULT 1
                                  CONSTRAINT concrete_project_settings_version_check
                                  CHECK (version >= 1),
  CONSTRAINT concrete_project_settings_updated_check CHECK (updated_at >= created_at)
);

-- Settings are never deleted: their history is the audit trail of concrete_project_settings.updated
-- events, and a project's settings outlive any edit.
CREATE FUNCTION concrete_project_settings_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concrete project settings are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_project_settings_no_delete';
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'concrete project settings keep their project and creation time'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_project_settings_fixed';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every concrete settings change increments the version by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_project_settings_version_step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_project_settings_guard
  BEFORE UPDATE OR DELETE ON concrete_project_settings
  FOR EACH ROW EXECUTE FUNCTION concrete_project_settings_guard();

-- D13 (AO08 Q1, Kyle 2026-10-29): the project's explicit concrete Lab Manager grant. Granted and
-- revoked by the project's Lead Project Engineer or an admin, with a reason; append-only like the
-- AO02 grant tables (one ending per row, never deleted). It counts only together with the global
-- lab_manager role (policy.ts, concrete_lab_manager source), so it is granted only to someone
-- holding that role; a later role removal leaves the row but ends its effect.
CREATE TABLE project_concrete_lab_manager_grant (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                    uuid NOT NULL REFERENCES project (id),
  lab_manager_user_id           uuid NOT NULL REFERENCES app_user (id),
  lab_manager_initials_snapshot text,
  lab_manager_name_snapshot     text NOT NULL,
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
  CONSTRAINT project_concrete_lab_manager_grant_revoked_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_name_snapshot IS NULL
     AND revoked_by_initials_snapshot IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL
        AND revoked_by_name_snapshot IS NOT NULL AND revoke_reason IS NOT NULL
        AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX project_concrete_lab_manager_grant_active_key
  ON project_concrete_lab_manager_grant (project_id, lab_manager_user_id) WHERE revoked_at IS NULL;
CREATE INDEX project_concrete_lab_manager_grant_user_idx
  ON project_concrete_lab_manager_grant (lab_manager_user_id) WHERE revoked_at IS NULL;
CREATE INDEX project_concrete_lab_manager_grant_project_idx
  ON project_concrete_lab_manager_grant (project_id, granted_at);

CREATE TRIGGER project_concrete_lab_manager_grant_history
  BEFORE UPDATE OR DELETE ON project_concrete_lab_manager_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_history_guard(
    'revoked_at', 'revoked_by_user_id', 'revoked_by_initials_snapshot', 'revoked_by_name_snapshot',
    'revoke_reason');
CREATE TRIGGER project_concrete_lab_manager_grant_personal
  BEFORE INSERT ON project_concrete_lab_manager_grant
  FOR EACH ROW EXECUTE FUNCTION assignment_subject_is_personal('lab_manager_user_id');

-- The recipient holds the lab_manager role when granted (the grant alone is never enough, D13).
CREATE FUNCTION project_concrete_lab_manager_grant_role() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role_assignment
                 WHERE user_id = NEW.lab_manager_user_id AND role = 'lab_manager') THEN
    RAISE EXCEPTION 'the concrete grant goes only to a Lab Manager'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_concrete_lab_manager_grant_role';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_concrete_lab_manager_grant_role
  BEFORE INSERT ON project_concrete_lab_manager_grant
  FOR EACH ROW EXECUTE FUNCTION project_concrete_lab_manager_grant_role();
