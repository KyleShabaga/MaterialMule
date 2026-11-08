-- MM-V2-C04: field-report detail (spec page 2 "Field report and field map"), the fresh-test
-- readings with retests, and the exactly-once ledger for the draft APIs. Adds columns to C01's
-- concrete_field_report; repurposes none (docs/concrete.md "Field ownership").
--
-- Drafts always save (AC1): every new column is nullable (or an empty list), and missing draft
-- data is NULL, never 0, false or "No". Draft completeness and the final-review checks are
-- computed from the record each time and never stored (packages/shared/src/concrete-field-reports.ts).
--
-- Three sources are kept apart (card §2): the project specification column and the supplier
-- ticket column as written on this report (autofilled from the mix, editable), the registry
-- snapshot they came from (concreteMixSnapshotSchema: the revision id plus copied values, never
-- re-read from the live mix), and the measured results (columns below and concrete_field_reading).
-- Nothing here writes the mix registry (C03 AC4).
--
-- Not decided, so not modelled: the paper sheet's Field ID vs Set ID meaning (CD-65) is stored as
-- uninterpreted text with no link to set identity; SCC / flow tests; whether unit weight is
-- required per project; admixture dosage rules; the printed element list (stored as labels).

ALTER TABLE concrete_field_report
  -- Project info. Client, project name and job number come from the project record.
  ADD COLUMN report_date date,
  ADD COLUMN contractor_name text
    CONSTRAINT concrete_field_report_contractor_name_check CHECK (length(contractor_name) BETWEEN 1 AND 200),
  -- CD-65 is open: the paper sheet's reference as written, with no meaning attached. It is never
  -- a set ID, never unique and never required.
  ADD COLUMN paper_field_id text
    CONSTRAINT concrete_field_report_paper_field_id_check CHECK (length(paper_field_id) BETWEEN 1 AND 50),
  -- Test location: element labels (multi-select; '{}' = none chosen yet), Other text, written
  -- location.
  ADD COLUMN location_elements text[] NOT NULL DEFAULT '{}'
    CONSTRAINT concrete_field_report_location_elements_check
    CHECK (cardinality(location_elements) <= 40 AND array_position(location_elements, NULL) IS NULL),
  ADD COLUMN location_element_other text
    CONSTRAINT concrete_field_report_location_element_other_check CHECK (length(location_element_other) BETWEEN 1 AND 200),
  ADD COLUMN location_description text
    CONSTRAINT concrete_field_report_location_description_check CHECK (length(location_description) BETWEEN 1 AND 500),
  -- Delivery. Identifiers are text so leading zeros are kept. No uniqueness on the ticket number:
  -- repeat sampling of one load is legitimate; the API returns a duplicate warning (CD-18).
  ADD COLUMN supplier_name text
    CONSTRAINT concrete_field_report_supplier_name_check CHECK (length(supplier_name) BETWEEN 1 AND 200),
  ADD COLUMN mix_number text
    CONSTRAINT concrete_field_report_mix_number_check CHECK (length(mix_number) BETWEEN 1 AND 100),
  ADD COLUMN ticket_number text
    CONSTRAINT concrete_field_report_ticket_number_check CHECK (length(ticket_number) BETWEEN 1 AND 100),
  ADD COLUMN truck_number text
    CONSTRAINT concrete_field_report_truck_number_check CHECK (length(truck_number) BETWEEN 1 AND 100),
  ADD COLUMN plant_name text
    CONSTRAINT concrete_field_report_plant_name_check CHECK (length(plant_name) BETWEEN 1 AND 200),
  ADD COLUMN batched_at timestamptz,
  ADD COLUMN load_volume_m3 numeric(8, 2)
    CONSTRAINT concrete_field_report_load_volume_check CHECK (load_volume_m3 >= 0),
  -- Manual (card §2): never computed from other reports.
  ADD COLUMN cumulative_volume_m3 numeric(10, 2)
    CONSTRAINT concrete_field_report_cumulative_volume_check CHECK (cumulative_volume_m3 >= 0),
  -- The registry mix chosen, if any (same project), and the snapshot taken when it was chosen.
  -- NULL mix with typed supplier / mix number = an unknown mix (CD-15), flagged by the API.
  ADD COLUMN mix_id uuid,
  ADD COLUMN mix_snapshot jsonb,
  -- The two columns of "Mix spec vs ticket" as on this report (objects; null members = blank).
  ADD COLUMN project_spec jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT concrete_field_report_project_spec_check CHECK (jsonb_typeof(project_spec) = 'object'),
  ADD COLUMN ticket_spec jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT concrete_field_report_ticket_spec_check CHECK (jsonb_typeof(ticket_spec) = 'object'),
  -- Event times (24 h); each keeps its date, so midnight crossings stay right. Retest times are on
  -- the readings.
  ADD COLUMN arrived_at timestamptz,
  ADD COLUMN sampled_at timestamptz,
  ADD COLUMN tested_at timestamptz,
  ADD COLUMN cast_at timestamptz,
  ADD COLUMN time_limit_exceeded boolean,
  ADD COLUMN time_limit_informed text
    CONSTRAINT concrete_field_report_time_limit_informed_check CHECK (length(time_limit_informed) BETWEEN 1 AND 200),
  -- Load decision (separate from the app's review and issue).
  ADD COLUMN load_rejected boolean,
  ADD COLUMN load_decision_by_name text
    CONSTRAINT concrete_field_report_load_decision_by_name_check CHECK (length(load_decision_by_name) BETWEEN 1 AND 200),
  ADD COLUMN load_decision_by_company text
    CONSTRAINT concrete_field_report_load_decision_by_company_check CHECK (length(load_decision_by_company) BETWEEN 1 AND 200),
  ADD COLUMN sampling_location text
    CONSTRAINT concrete_field_report_sampling_location_check
    CHECK (sampling_location IN ('chute', 'end_of_pump', 'hopper', 'other')),
  ADD COLUMN sampling_location_other text
    CONSTRAINT concrete_field_report_sampling_location_other_check CHECK (length(sampling_location_other) BETWEEN 1 AND 200),
  -- Multi-select; the server never derives it from the sampling location (a manual choice is
  -- never overwritten).
  ADD COLUMN placement_methods text[] NOT NULL DEFAULT '{}'
    CONSTRAINT concrete_field_report_placement_methods_check
    CHECK (placement_methods <@ ARRAY['chute', 'pump', 'extruder', 'crane_bucket', 'wheel_barrow', 'other']::text[]
           AND array_position(placement_methods, NULL) IS NULL),
  ADD COLUMN placement_method_other text
    CONSTRAINT concrete_field_report_placement_method_other_check CHECK (length(placement_method_other) BETWEEN 1 AND 200),
  -- The form preselects Concrete; the server stores only what was chosen.
  ADD COLUMN material text
    CONSTRAINT concrete_field_report_material_check
    CHECK (material IN ('concrete', 'epoxy_grout', 'cementitious_grout', 'cellular_concrete', 'scc')),
  ADD COLUMN superplasticizer_added text
    CONSTRAINT concrete_field_report_superplasticizer_added_check
    CHECK (superplasticizer_added IN ('on_site', 'at_plant', 'none')),
  -- Other fresh tests. Temperatures may be negative.
  ADD COLUMN unit_weight_kg_m3 numeric(7, 1)
    CONSTRAINT concrete_field_report_unit_weight_check CHECK (unit_weight_kg_m3 > 0),
  ADD COLUMN concrete_temp_c numeric(4, 1)
    CONSTRAINT concrete_field_report_concrete_temp_check CHECK (concrete_temp_c BETWEEN -60 AND 100),
  ADD COLUMN ambient_temp_c numeric(4, 1)
    CONSTRAINT concrete_field_report_ambient_temp_check CHECK (ambient_temp_c BETWEEN -60 AND 100),
  ADD COLUMN water_added boolean,
  ADD COLUMN water_added_authorized_by text
    CONSTRAINT concrete_field_report_water_authorized_check CHECK (length(water_added_authorized_by) BETWEEN 1 AND 200),
  -- Specimens cast? (the form preselects Yes). Set and specimen detail is C05's.
  ADD COLUMN specimens_cast boolean,
  -- The air meter used (optional, CD-45) and its calibration evaluation when chosen (C27).
  ADD COLUMN air_meter_equipment_id uuid REFERENCES concrete_equipment (id),
  ADD COLUMN air_meter_use jsonb,
  ADD COLUMN comments text
    CONSTRAINT concrete_field_report_comments_check CHECK (length(comments) BETWEEN 1 AND 4000),
  ADD COLUMN results_reported_to_name text
    CONSTRAINT concrete_field_report_reported_to_name_check CHECK (length(results_reported_to_name) BETWEEN 1 AND 200),
  ADD COLUMN results_reported_to_company text
    CONSTRAINT concrete_field_report_reported_to_company_check CHECK (length(results_reported_to_company) BETWEEN 1 AND 200),
  -- Attachment references: metadata only (C15 owns files and their acknowledgment).
  ADD COLUMN attachment_refs jsonb NOT NULL DEFAULT '[]'
    CONSTRAINT concrete_field_report_attachment_refs_check CHECK (jsonb_typeof(attachment_refs) = 'array'),
  -- A registry mix belongs to the report's project; a project correction must clear it first.
  ADD CONSTRAINT concrete_field_report_mix_fkey FOREIGN KEY (project_id, mix_id)
    REFERENCES concrete_mix (project_id, id),
  -- A snapshot exists exactly when a registry mix is chosen, and names that mix.
  ADD CONSTRAINT concrete_field_report_mix_snapshot_check CHECK (
    (mix_id IS NULL AND mix_snapshot IS NULL)
    OR (mix_id IS NOT NULL AND mix_snapshot IS NOT NULL
        AND jsonb_typeof(mix_snapshot) = 'object'
        AND coalesce(mix_snapshot ->> 'mixId' = mix_id::text, false))
  ),
  -- An air-meter evaluation needs the meter it evaluates.
  ADD CONSTRAINT concrete_field_report_air_meter_use_check CHECK (
    air_meter_use IS NULL
    OR (air_meter_equipment_id IS NOT NULL AND jsonb_typeof(air_meter_use) = 'object'
        AND coalesce(air_meter_use ->> 'equipmentId' = air_meter_equipment_id::text, false))
  );

CREATE INDEX concrete_field_report_mix_idx ON concrete_field_report (mix_id) WHERE mix_id IS NOT NULL;
CREATE INDEX concrete_field_report_air_meter_idx
  ON concrete_field_report (air_meter_equipment_id) WHERE air_meter_equipment_id IS NOT NULL;
-- Duplicate supplier + ticket lookup (CD-18), ignoring case and surrounding blanks.
CREATE INDEX concrete_field_report_ticket_idx
  ON concrete_field_report (lower(btrim(supplier_name)), lower(btrim(ticket_number)))
  WHERE supplier_name IS NOT NULL AND ticket_number IS NOT NULL;
CREATE INDEX concrete_field_report_project_date_idx
  ON concrete_field_report (project_id, report_date DESC NULLS LAST, created_at DESC, id);

-- The air meter chosen on a report is an air meter (not the testing machine).
CREATE FUNCTION concrete_field_report_air_meter_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.air_meter_equipment_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.air_meter_equipment_id IS DISTINCT FROM OLD.air_meter_equipment_id)
     AND NOT EXISTS (SELECT 1 FROM concrete_equipment e
                     WHERE e.id = NEW.air_meter_equipment_id AND e.kind = 'air_meter') THEN
    RAISE EXCEPTION 'the air meter on a field report must be an air meter'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_field_report_air_meter_kind';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_report_air_meter_check
  BEFORE INSERT OR UPDATE OF air_meter_equipment_id ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_air_meter_check();

-- One fresh-test reading: slump or air, initial, retest or after an addition (card §2: several
-- retests with time and context and stable IDs, never overwriting the initial or post-addition
-- reading). Ordered by `position` within its report and test. The value may be blank in a draft.
CREATE TABLE concrete_field_reading (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL,
  field_report_id  uuid NOT NULL,
  test             text NOT NULL
                     CONSTRAINT concrete_field_reading_test_check CHECK (test IN ('slump', 'air')),
  context          text NOT NULL
                     CONSTRAINT concrete_field_reading_context_check
                     CHECK (context IN ('initial', 'retest', 'after_superplasticizer', 'after_water')),
  position         integer NOT NULL
                     CONSTRAINT concrete_field_reading_position_check CHECK (position BETWEEN 1 AND 50),
  -- Slump mm, air %. NULL = not measured yet (never 0).
  value            numeric(6, 1)
                     CONSTRAINT concrete_field_reading_value_check CHECK (value >= 0),
  measured_at      timestamptz,
  note             text CONSTRAINT concrete_field_reading_note_check CHECK (length(note) BETWEEN 1 AND 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
                     CONSTRAINT concrete_field_reading_version_check CHECK (version >= 1),
  CONSTRAINT concrete_field_reading_air_percent CHECK (test <> 'air' OR value <= 100),
  -- The reading belongs to its report's project (a report's project correction carries it).
  CONSTRAINT concrete_field_reading_report_fkey FOREIGN KEY (project_id, field_report_id)
    REFERENCES concrete_field_report (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_field_reading_position_key UNIQUE (field_report_id, test, position)
    DEFERRABLE INITIALLY DEFERRED
);
-- One initial reading per test; retests and post-addition readings are separate rows.
CREATE UNIQUE INDEX concrete_field_reading_one_initial
  ON concrete_field_reading (field_report_id, test) WHERE context = 'initial';
CREATE INDEX concrete_field_reading_project_idx ON concrete_field_reading (project_id);

-- A reading keeps its id, report, test and context: a retest is never turned into the initial
-- reading (or the reverse) by an edit; a mistaken row is removed and a new one added instead.
CREATE FUNCTION concrete_field_reading_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'concrete field readings can''t be truncated' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.field_report_id IS DISTINCT FROM OLD.field_report_id
     OR NEW.test IS DISTINCT FROM OLD.test OR NEW.context IS DISTINCT FROM OLD.context THEN
    RAISE EXCEPTION 'reading % keeps its id, report, test and context', OLD.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_field_reading_identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_reading_guard
  BEFORE UPDATE ON concrete_field_reading
  FOR EACH ROW EXECUTE FUNCTION concrete_field_reading_guard();
CREATE TRIGGER concrete_field_reading_no_truncate
  BEFORE TRUNCATE ON concrete_field_reading
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_field_reading_guard();

-- Exactly-once draft commands (create, save): a retried request with the same key and body
-- returns the report as it stands without a second version or audit event; the same key for a
-- different request is refused by the API (409 idempotency_key_reused). Append-only.
CREATE TABLE concrete_field_report_command (
  idempotency_key  uuid PRIMARY KEY,
  report_id        uuid NOT NULL REFERENCES concrete_field_report (id),
  kind             text NOT NULL
                     CONSTRAINT concrete_field_report_command_kind_check
                     CHECK (kind IN ('create', 'save')),
  request_hash     text NOT NULL,
  user_id          uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concrete_field_report_command_report_idx ON concrete_field_report_command (report_id);
CREATE INDEX concrete_field_report_command_user_idx ON concrete_field_report_command (user_id);

CREATE FUNCTION concrete_field_report_command_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete field report commands are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_field_report_command_append_only';
END;
$$;
CREATE TRIGGER concrete_field_report_command_guard
  BEFORE UPDATE OR DELETE ON concrete_field_report_command
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_command_guard();
