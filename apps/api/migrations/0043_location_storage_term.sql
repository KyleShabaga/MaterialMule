-- STRATA-106 (Strata redesign, lane B): storage term on locations and a small location hierarchy.
--
-- Kyle (2026-11-12): the storage term (short- or long-term) is set on a warehouse, inherited by
-- its bays and shelves, and can be overridden on a bay or a shelf. Locations were flat, so this
-- adds:
-- * `parent_location_id`: the location this one sits in (a bay in a warehouse, a shelf in a bay);
--   null at the top. At most three levels (warehouse › bay › shelf), never itself, never a cycle.
-- * `storage_term`: this location's own term; null means inherit (or "not set" at the top). Never
--   backfilled from names: every existing location starts unset, an explicit configuration state.
-- * `capacity`: a shelf's countable places (STRATA-74), 1–200; null means unknown (never a guess).
--
-- The system Receiving lab and lab locations sit outside the hierarchy: no parent, no term, and
-- they are nobody's parent (a unit there is Received or In lab, never in storage). A retired
-- location can't gain children.
--
-- The effective term is never stored: the view `location_effective_storage_term` resolves the
-- nearest own term walking up, so reparenting, clearing an override or changing a warehouse's
-- term changes every descendant's reading at once.
--
-- Concurrency: hierarchy changes (insert with a parent, a new parent, a kind change, retirement)
-- serialise on `location_hierarchy_lock()`, so two concurrent reparents can't build a cycle or a
-- fourth level, and a retirement can't miss a child being added. The API takes the lock before it
-- locks any location row, and the trigger takes it again (re-entrant) for direct writes.

ALTER TABLE location
  ADD COLUMN parent_location_id uuid REFERENCES location (id),
  ADD COLUMN storage_term text
    CONSTRAINT location_storage_term_check CHECK (storage_term IN ('short_term', 'long_term')),
  ADD COLUMN capacity integer
    CONSTRAINT location_capacity_check CHECK (capacity BETWEEN 1 AND 200),
  ADD CONSTRAINT location_parent_not_self_check CHECK (parent_location_id <> id),
  -- Receiving lab and lab locations: no parent and no term.
  ADD CONSTRAINT location_lab_outside_hierarchy_check CHECK (
    NOT (is_system OR kind IN ('receiving_lab', 'lab'))
    OR (parent_location_id IS NULL AND storage_term IS NULL)
  );

CREATE INDEX location_parent_idx ON location (parent_location_id)
  WHERE parent_location_id IS NOT NULL;

-- Two-key form, its own key space (grant review uses 25, review eligibility 26).
CREATE FUNCTION location_hierarchy_lock() RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(27, 0)
$$;

CREATE FUNCTION location_hierarchy_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_row     location%ROWTYPE;
  levels_above   integer;
  levels_below   integer;
  makes_cycle    boolean;
BEGIN
  PERFORM location_hierarchy_lock();

  -- A location that becomes a lab (or the system location) can't keep children.
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind
     AND (NEW.is_system OR NEW.kind IN ('receiving_lab', 'lab'))
     AND EXISTS (SELECT 1 FROM location c WHERE c.parent_location_id = NEW.id) THEN
    RAISE EXCEPTION 'location % holds other locations, so it can''t be a lab', NEW.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'location_parent_kind_check';
  END IF;

  -- Unchanged, top level, or its own parent (location_parent_not_self_check reports that).
  IF NEW.parent_location_id IS NULL OR NEW.parent_location_id = NEW.id
     OR (TG_OP = 'UPDATE' AND NEW.parent_location_id IS NOT DISTINCT FROM OLD.parent_location_id) THEN
    RETURN NEW;
  END IF;

  -- Each statement reads a fresh snapshot (READ COMMITTED), so after the lock this sees every
  -- hierarchy change committed before it.
  SELECT * INTO parent_row FROM location WHERE id = NEW.parent_location_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports it
  END IF;
  IF parent_row.is_system OR parent_row.kind IN ('receiving_lab', 'lab') THEN
    RAISE EXCEPTION 'location % can''t hold other locations', parent_row.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'location_parent_kind_check';
  END IF;
  IF NOT parent_row.active THEN
    RAISE EXCEPTION 'location % is retired and can''t gain locations', parent_row.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'location_parent_retired_check';
  END IF;

  -- Walk up from the new parent: a cycle if this location is on the way; the stored hierarchy is
  -- acyclic, so the walk ends (the depth bound is only a backstop).
  WITH RECURSIVE up (id, parent_id, depth) AS (
    SELECT l.id, l.parent_location_id, 1 FROM location l WHERE l.id = NEW.parent_location_id
    UNION ALL
    SELECT l.id, l.parent_location_id, up.depth + 1
    FROM up JOIN location l ON l.id = up.parent_id
    WHERE up.depth < 10 AND up.id <> NEW.id
  )
  SELECT bool_or(id = NEW.id), max(depth) INTO makes_cycle, levels_above FROM up;
  IF makes_cycle THEN
    RAISE EXCEPTION 'location % can''t sit inside itself', NEW.code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'location_parent_cycle_check';
  END IF;

  -- Levels this location already holds below it (0 for a new one).
  levels_below := 0;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE down (id, depth) AS (
      SELECT c.id, 1 FROM location c WHERE c.parent_location_id = NEW.id
      UNION ALL
      SELECT c.id, down.depth + 1
      FROM down JOIN location c ON c.parent_location_id = down.id
      WHERE down.depth < 10
    )
    SELECT coalesce(max(depth), 0) INTO levels_below FROM down;
  END IF;

  IF levels_above + 1 + levels_below > 3 THEN
    RAISE EXCEPTION 'locations nest at most three levels (warehouse, bay, shelf)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'location_parent_depth_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_hierarchy_check
  BEFORE INSERT OR UPDATE OF parent_location_id, kind, active ON location
  FOR EACH ROW EXECUTE FUNCTION location_hierarchy_check();

-- The one resolver for a location's effective storage term: its own term, else the nearest
-- ancestor's, else unset. Three levels at most, so two joins reach the top.
-- `source`: 'own', 'inherited' or 'unset'; `from_*` names the location the term comes from.
CREATE VIEW location_effective_storage_term AS
SELECT l.id AS location_id,
       coalesce(l.storage_term, p.storage_term, g.storage_term) AS term,
       CASE
         WHEN l.storage_term IS NOT NULL THEN 'own'
         WHEN coalesce(p.storage_term, g.storage_term) IS NOT NULL THEN 'inherited'
         ELSE 'unset'
       END AS source,
       f.id AS from_location_id,
       f.code_normalized AS from_code,
       f.name AS from_name
FROM location l
LEFT JOIN location p ON p.id = l.parent_location_id
LEFT JOIN location g ON g.id = p.parent_location_id
LEFT JOIN location f ON f.id = CASE
                                 WHEN l.storage_term IS NOT NULL THEN l.id
                                 WHEN p.storage_term IS NOT NULL THEN p.id
                                 WHEN g.storage_term IS NOT NULL THEN g.id
                               END;
