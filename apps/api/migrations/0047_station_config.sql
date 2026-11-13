-- Strata lane A (STRATA-20, 21, 63): each LAB station's "At this station" rows, their order and
-- which ones show. A station is identified by a random ID made once on that computer
-- (`materialmule.station.id`, the shared `stationIdSchema`); it is not an account.
--
-- * One row per station, saved only when someone customizes it: no row means the defaults
--   (version 0 in the API), so a stored row starts at version 1 and each save adds exactly one.
-- * `rows` is the canonical list the API wrote (`normalizeStationRows`); the API normalizes it
--   again on read, so a list from an older release never breaks the page.
-- * Only a Lab Manager with their own account saves (Kyle 2026-11-12/13, STRATA-36): the person
--   who saved is an active personal or test account holding the lab_manager role at that moment,
--   never the shared LAB account, whoever a station picks.

CREATE TABLE station_config (
  station_id          text PRIMARY KEY
                        CONSTRAINT station_config_station_id_check
                        CHECK (station_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  rows                jsonb NOT NULL
                        CONSTRAINT station_config_rows_check CHECK (jsonb_typeof(rows) = 'array'),
  version             integer NOT NULL DEFAULT 1
                        CONSTRAINT station_config_version_check CHECK (version >= 1),
  updated_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION station_config_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
    JOIN role_assignment r ON r.user_id = u.id AND r.role = 'lab_manager'
    WHERE u.id = NEW.updated_by_user_id AND u.status = 'active' AND u.account_type <> 'shared_lab'
  ) THEN
    RAISE EXCEPTION 'a station is customized by a Lab Manager with their own account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'station_config_updater_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a station''s first save is version 1'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'station_config_version_step_check';
    END IF;
  ELSE
    IF NEW.station_id IS DISTINCT FROM OLD.station_id THEN
      RAISE EXCEPTION 'a station''s ID never changes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'station_config_station_id_fixed_check';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'each save adds one to the version'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'station_config_version_step_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER station_config_guard
  BEFORE INSERT OR UPDATE ON station_config
  FOR EACH ROW EXECUTE FUNCTION station_config_guard();
