-- TRP-T12: inventory search, filters and stable paging.
--
-- Search matches every word somewhere in a storage unit's searchable text: its ID, type and note,
-- project number / name / client, each test-hole name with its SAMPLE#/DEPTH summary (including
-- Custom text and summary notes) and the saved location. Gathering that text needs four joins, so
-- a trigger-maintained document per unit (storage_unit_search) keeps it in one lower-cased column
-- with a trigram index, and each search word becomes `document LIKE '%word%'`. Triggers refresh
-- the document whenever any source value changes, inside the same transaction.
--
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it. It lives in
-- public so every schema (including per-test-file schemas) shares one copy.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE storage_unit_search (
  storage_unit_id uuid PRIMARY KEY REFERENCES storage_unit (id),
  -- Lower-cased, newline-separated searchable values. Never shown to users.
  document        text NOT NULL
);

-- The searchable text of one unit, built from current values. Fields are separated by newlines so
-- a word never matches across two fields (search words never contain whitespace).
CREATE FUNCTION storage_unit_search_document(unit_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT lower(concat_ws(E'\n',
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
              END,
              h.custom_text,
              h.note), E'\n' ORDER BY th.name_normalized)
     FROM storage_unit_hole_summary h
     JOIN test_hole th ON th.id = h.test_hole_id
     WHERE h.storage_unit_id = su.id)))
  FROM storage_unit su
  JOIN project p ON p.id = su.project_id
  JOIN location l ON l.id = su.current_location_id
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
  AFTER INSERT OR UPDATE OF readable_id, unit_type, note, project_id, current_location_id
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

CREATE FUNCTION storage_unit_search_on_test_hole() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_storage_unit_search(ARRAY(
    SELECT storage_unit_id FROM storage_unit_hole_summary WHERE test_hole_id = NEW.id));
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

-- Units that existed before this migration.
SELECT refresh_storage_unit_search(ARRAY(SELECT id FROM storage_unit));

CREATE INDEX storage_unit_search_document_trgm_idx
  ON storage_unit_search USING gin (document public.gin_trgm_ops);

-- Sorting: received date or ID, with the ID as the tie-breaker so pages never overlap or skip.
-- "C" collation compares the ID byte by byte (BKT-2026-000014 before BKT-2026-000015) whatever the
-- database's locale.
CREATE INDEX storage_unit_received_id_idx
  ON storage_unit (received_date, readable_id COLLATE "C");
CREATE INDEX storage_unit_readable_id_c_idx ON storage_unit (readable_id COLLATE "C");
