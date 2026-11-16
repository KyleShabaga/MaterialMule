-- Strata redesign, lane 1C (STRATA-11, 29, 40, 41, 51): per-person settings kept on the server,
-- so they come back on any computer the person signs in to.
--
-- - person_setting: one JSON document per person per area, with its own optimistic version. The
--   API normalizes every value on read (packages/shared sidebar.ts / user-preferences.ts), so a
--   stored document from an older release never breaks a screen.
-- - person_pin / person_recent: records a person pinned or opened lately, by stable kind and ID.
--   No foreign key to the records (they are polymorphic): reads recheck that each record exists
--   and that the person may still open it.
--
-- Only personal and test accounts own rows: the shared LAB account never saves a layout,
-- preferences, pins or recents, whoever a station selects.

CREATE TABLE person_setting (
  user_id     uuid NOT NULL REFERENCES app_user (id),
  area        text NOT NULL
                CONSTRAINT person_setting_area_check
                CHECK (area IN ('sidebar_layout', 'preferences', 'table_columns')),
  value       jsonb NOT NULL
                CONSTRAINT person_setting_value_check CHECK (jsonb_typeof(value) = 'object'),
  -- 0 means "never saved" in the API, so a stored row starts at 1.
  version     integer NOT NULL DEFAULT 1
                CONSTRAINT person_setting_version_check CHECK (version >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_setting_pkey PRIMARY KEY (user_id, area)
);

CREATE TABLE person_pin (
  user_id      uuid NOT NULL REFERENCES app_user (id),
  record_kind  text NOT NULL
                 CONSTRAINT person_pin_record_kind_check
                 CHECK (record_kind IN ('storage_unit', 'project', 'lab_program', 'specimen_set')),
  record_id    uuid NOT NULL,
  pinned_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_pin_pkey PRIMARY KEY (user_id, record_kind, record_id)
);
CREATE INDEX person_pin_order_idx ON person_pin (user_id, pinned_at);

CREATE TABLE person_recent (
  user_id      uuid NOT NULL REFERENCES app_user (id),
  record_kind  text NOT NULL
                 CONSTRAINT person_recent_record_kind_check
                 CHECK (record_kind IN ('storage_unit', 'project', 'lab_program', 'specimen_set')),
  record_id    uuid NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_recent_pkey PRIMARY KEY (user_id, record_kind, record_id)
);
CREATE INDEX person_recent_order_idx ON person_recent (user_id, opened_at DESC);

-- The owner must be a personal or test account: never the shared LAB account.
CREATE FUNCTION person_settings_owner_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND account_type = 'shared_lab') THEN
    RAISE EXCEPTION 'personal settings belong to a personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'person_settings_owner_personal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_setting_owner_guard
  BEFORE INSERT OR UPDATE OF user_id ON person_setting
  FOR EACH ROW EXECUTE FUNCTION person_settings_owner_guard();
CREATE TRIGGER person_pin_owner_guard
  BEFORE INSERT OR UPDATE OF user_id ON person_pin
  FOR EACH ROW EXECUTE FUNCTION person_settings_owner_guard();
CREATE TRIGGER person_recent_owner_guard
  BEFORE INSERT OR UPDATE OF user_id ON person_recent
  FOR EACH ROW EXECUTE FUNCTION person_settings_owner_guard();
