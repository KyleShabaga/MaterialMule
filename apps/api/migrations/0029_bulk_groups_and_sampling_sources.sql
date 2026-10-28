-- MM-T36 (receiving increment): individually tracked Shelby tubes with a sampling source, and
-- bulk-sample groups of physical buckets.
--
-- Sampling source vs storage location: the source (a same-project test hole, or a free-text
-- standalone sampling location) is where the material came from; current_location_id is where
-- the physical unit is now. They are never the same column.
--
-- Shelby tube (unit_type shelby_tube, holder shelby_tube, ST- ID): the source and the optional
-- sample reference and depth live on the unit itself. A standalone source is free text on that
-- unit only: there is no directory of standalone locations (owner decision 2026-10-27), and two
-- units with the same text are never merged into one source.
--
-- Bulk soil bucket (unit_type bulk_container, holder bucket, BKT- ID): the existing
-- bulk_container unit type now means "bucket holding a bulk soil sample". The physical holder is
-- still a bucket (BKT-), never a generic CT container. Its only contents summary is its bulk
-- group's identity: project, source, required sample reference (usually B1, B2…, never forced),
-- required depth (single or interval) with units, optional description. The identity is stored
-- once on bulk_group and inherited by every member bucket. A group's ID is a random UUID: no
-- group letters, and B1 is not unique (another hole or location may have its own B1).
-- "Bucket n of N" is computed when read (received date, then readable ID) and never stored.
--
-- A unit has exactly one kind of contents summary: hole summaries (ordinary bucket), its own
-- sample identity (Shelby tube with a source) or its bulk group (bulk soil bucket). Shelby tubes
-- received before this migration (none in production) keep whatever they had; they simply have
-- no source until a later correction adds one.
--
-- Search: storage_unit_search_document is redefined from migration 0027's version (dash folding
-- and displayed-summary forms kept) to add sources, sample references, depths and bulk groups.
-- Sticker: storage_unit_origin_names gives the existing origin field (test-hole / field-location
-- names) for every kind of unit; no new sticker fields.
--
-- Not in this migration: tested-unit removal (T36 post-testing route), which needs real
-- exact-unit completion evidence from T23/T24 first.

-- ---------------------------------------------------------------------------------------------
-- Bulk-sample groups
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- Storage unit: sampling source, sample identity and group membership
-- ---------------------------------------------------------------------------------------------

ALTER TABLE storage_unit
  ADD COLUMN source_type text
    CONSTRAINT storage_unit_source_type_check
    CHECK (source_type IN ('test_hole', 'standalone_location')),
  ADD COLUMN source_test_hole_id uuid,
  ADD COLUMN source_location_reference text
    CONSTRAINT storage_unit_source_location_reference_check
    CHECK (source_location_reference = btrim(source_location_reference)
           AND length(source_location_reference) BETWEEN 1 AND 100
           AND source_location_reference !~ '[[:cntrl:]]'),
  ADD COLUMN sample_reference text
    CONSTRAINT storage_unit_sample_reference_check
    CHECK (sample_reference = btrim(sample_reference)
           AND length(sample_reference) BETWEEN 1 AND 40
           AND sample_reference !~ '[[:cntrl:]]'),
  ADD COLUMN sample_depth_from numeric(8, 2),
  ADD COLUMN sample_depth_to numeric(8, 2),
  ADD COLUMN sample_depth_unit text
    CONSTRAINT storage_unit_sample_depth_unit_check CHECK (sample_depth_unit IN ('ft', 'm')),
  ADD COLUMN bulk_group_id uuid,
  -- The source hole and the group both belong to the unit's project.
  ADD CONSTRAINT storage_unit_source_test_hole_fk FOREIGN KEY (project_id, source_test_hole_id)
    REFERENCES test_hole (project_id, id),
  ADD CONSTRAINT storage_unit_bulk_group_fk FOREIGN KEY (project_id, bulk_group_id)
    REFERENCES bulk_group (project_id, id),
  -- Exactly one source kind, with its matching reference, and no sample identity without one.
  ADD CONSTRAINT storage_unit_source_shape_check CHECK (
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
  ADD CONSTRAINT storage_unit_sample_depth_check CHECK (
    (sample_depth_from IS NULL AND sample_depth_to IS NULL AND sample_depth_unit IS NULL)
    OR (sample_depth_from IS NOT NULL AND sample_depth_from >= 0 AND sample_depth_unit IS NOT NULL
        AND (sample_depth_to IS NULL OR sample_depth_to >= sample_depth_from))
  ),
  -- Which units carry what:
  --   ordinary bucket: hole summaries only (no source, no group);
  --   Shelby tube: its own source (legacy tubes from before 0029 may have none), never a group;
  --   bulk soil bucket: holder bucket, exactly one group, no own source;
  --   generic CT bulk container (separate generic-container rules): neither.
  ADD CONSTRAINT storage_unit_contents_by_type_check CHECK (
    (unit_type = 'bucket' AND source_type IS NULL AND bulk_group_id IS NULL)
    OR (unit_type = 'shelby_tube' AND bulk_group_id IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'bucket'
        AND bulk_group_id IS NOT NULL AND source_type IS NULL)
    OR (unit_type = 'bulk_container' AND holder_kind = 'generic'
        AND bulk_group_id IS NULL AND source_type IS NULL)
  );

CREATE INDEX storage_unit_bulk_group_idx
  ON storage_unit (bulk_group_id, received_date, readable_id COLLATE "C")
  WHERE bulk_group_id IS NOT NULL;
CREATE INDEX storage_unit_source_test_hole_idx
  ON storage_unit (source_test_hole_id) WHERE source_test_hole_id IS NOT NULL;

-- One contents summary per unit: a unit with its own sample identity or a bulk group never also
-- has hole summaries (a bulk soil bucket always has a group, see the check above). Checked from both sides so neither insert order can get round it.
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

-- ---------------------------------------------------------------------------------------------
-- Sticker origin field
-- ---------------------------------------------------------------------------------------------

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
-- Inventory search (redefines 0027's version; everything it held is kept)
-- ---------------------------------------------------------------------------------------------

-- Added after 0027's values, for a Shelby tube's own identity or a bulk bucket's group identity:
--   * "shelby tube" already comes from the unit type; bulk buckets add "bulk soil sample";
--   * the source name (test hole or standalone location text), the sample reference, the depth
--     as separate ends ("1.5 2 m") and joined ("1.5-2 m"), and the group description;
--   * the identity as formatSampleIdentity displays it, e.g. "th26-21: b1 at 1.5-2 m".
-- The same dash folding as 0027 then applies to the whole document.
CREATE OR REPLACE FUNCTION storage_unit_search_document(unit_id uuid) RETURNS text
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

-- The unit trigger now also fires when its source, sample identity or group changes.
DROP TRIGGER storage_unit_search_unit ON storage_unit;
CREATE TRIGGER storage_unit_search_unit
  AFTER INSERT OR UPDATE OF readable_id, unit_type, note, project_id, current_location_id,
    source_type, source_test_hole_id, source_location_reference, sample_reference,
    sample_depth_from, sample_depth_to, sample_depth_unit, bulk_group_id
  ON storage_unit
  FOR EACH ROW EXECUTE FUNCTION storage_unit_search_on_unit();

-- A renamed hole refreshes units that summarise it, tubes sourced from it and bulk buckets whose
-- group is sourced from it.
CREATE OR REPLACE FUNCTION storage_unit_search_on_test_hole() RETURNS trigger
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

-- Rebuild every stored document with the new definition (old records gain nothing new but keep
-- every 0027 form).
SELECT refresh_storage_unit_search(ARRAY(SELECT id FROM storage_unit));
