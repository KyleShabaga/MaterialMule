-- MM-T29: retention dates, holds, extensions and retention requests.
--
-- One calculation, used by inventory, detail screens and MM-T30 disposal: the unit_retention
-- view. Standard minimum retain-until = received date + 1 calendar year (PostgreSQL clamps a
-- Feb 29 receipt to Feb 28). A unit is date-eligible ON its effective retain-until date (owner,
-- 2026-10-25): eligible_by_date(as_of) is `effective_retain_until <= as_of`, with as_of today in
-- the business time zone, passed by the API (tests inject it).
--
-- Holds and extensions are project-wide or selected-unit, always with a reason, set and released
-- by the project's PM/PE or a Lab Manager. A project-wide hold or extension covers current and
-- future units of the project until released. Rows are never deleted; release is recorded once
-- (who, when, why) and the row is otherwise immutable, so the rows themselves are the history.
-- A receipt-date correction changes received_date, and the view recomputes at once; the old date
-- stays in the correction history (MM-T13). Program closure never touches any of this.
--
-- Tested-unit exception (MM-T36 owner amendments, 2026-10-27): a Shelby tube, or a bucket
-- explicitly holding a bulk soil sample (bulk_container in a bulk group), with completed-test
-- evidence linked to that exact unit (request not cancelled, same project) is retention-exempt.
-- Source, group membership, ALL coverage or a sibling's test never counts. The exemption is a
-- read-out only: holds and extensions keep covering the unit in history and keep covering every
-- other unit; nothing is released because one unit is exempt.
--
-- Requests: other internal users ask for a hold or extension (retention_request). The request
-- opens one action_item (kind retention_request) routed to the project's PM/PE and every Lab
-- Manager (MM-T27). Approving creates the hold/extension as the decider and resolves the item for
-- everyone; declining resolves it with a reason. Nothing changes until a decision.

-- ---------------------------------------------------------------------------------------------
-- Holds
-- ---------------------------------------------------------------------------------------------

CREATE TABLE retention_hold (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                  uuid NOT NULL REFERENCES project (id),
  scope                       text NOT NULL CHECK (scope IN ('project', 'units')),
  reason                      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  placed_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  placed_by_initials_snapshot text,
  placed_by_name_snapshot     text NOT NULL,
  placed_at                   timestamptz NOT NULL DEFAULT now(),
  -- Set when it came from an approved request.
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

-- ---------------------------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- The one calculation
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- Requests (routed through action_item, MM-T27)
-- ---------------------------------------------------------------------------------------------

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

-- action_item: the retention_request kind (no program), resolved by approval or decline.
ALTER TABLE action_item DROP CONSTRAINT action_item_kind_check;
ALTER TABLE action_item DROP CONSTRAINT action_item_entity_type_check;
ALTER TABLE action_item DROP CONSTRAINT action_item_shape_check;
ALTER TABLE action_item DROP CONSTRAINT action_item_resolution_check1;
ALTER TABLE action_item
  ALTER COLUMN program_id DROP NOT NULL,
  ADD CONSTRAINT action_item_kind_check
    CHECK (kind IN ('correction', 'cancellation_request', 'closure_request', 'retention_request')),
  ADD CONSTRAINT action_item_entity_type_check
    CHECK (entity_type IN ('test_request', 'lab_program', 'retention_request')),
  ADD CONSTRAINT action_item_resolution_value_check
    CHECK (resolution IN ('correction_done', 'cancelled', 'closed', 'approved', 'declined')),
  ADD CONSTRAINT action_item_shape_check CHECK (
    CASE kind
      WHEN 'correction' THEN entity_type = 'test_request' AND opened_by_event_id IS NOT NULL
        AND program_id IS NOT NULL
      WHEN 'cancellation_request' THEN entity_type = 'test_request' AND reason IS NOT NULL
        AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL AND program_id IS NOT NULL
      WHEN 'closure_request' THEN entity_type = 'lab_program' AND entity_id = program_id
        AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
      WHEN 'retention_request' THEN entity_type = 'retention_request' AND program_id IS NULL
        AND reason IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL
        AND created_by_name_snapshot IS NOT NULL
      ELSE false
    END
  );

CREATE OR REPLACE FUNCTION action_item_routes_to_pm_pe(kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('cancellation_request', 'closure_request', 'retention_request')
$$;
