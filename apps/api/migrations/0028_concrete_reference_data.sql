-- MM-V2-C37: concrete reference data. Owner decisions of 2026-11-08 (Kyle):
--   1. Supplier list: an admin- or Lab Manager-managed list of concrete suppliers and their
--      plants. Mixes (C03) keep free-text supplier and plant names and may optionally link a
--      listed supplier. Mix-number uniqueness stays per project + supplier (C03's index).
--   2. Holiday calendar: an admin-managed list of company holiday dates, seeded with the Alberta
--      general holidays in seed/reference.sql. A specimen target on a holiday is flagged like a
--      weekend and never moved (the flag is computed by the API; nothing here moves a date).
--   3. Mix draft discard: an unapproved draft revision of an approved mix can be discarded; the
--      approved revision stays in effect and unchanged. Discarded revisions are kept (revisions
--      are never deleted) and never change again. No mix retirement.
--
-- Who may write is checked by the API (concrete_settings.supplier.manage: Lab Manager or admin;
-- concrete_settings.holiday.manage: admin; concrete_mix.manage for a discard: the project's Lead
-- Project Engineer). Integrity is checked here and proven in
-- apps/api/src/db/schema-concrete-reference-data.test.ts. No existing row changes.

-- ---------------------------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------------------------

CREATE TABLE concrete_supplier (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         text NOT NULL
                                 CONSTRAINT concrete_supplier_name_check
                                 CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  plant_names                  text[] NOT NULL DEFAULT '{}'
                                 CONSTRAINT concrete_supplier_plants_check
                                 CHECK (cardinality(plant_names) <= 20
                                        AND array_position(plant_names, NULL) IS NULL),
  -- Inactive suppliers stay on record (mixes may link them) but are not offered for new links.
  active                       boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  created_by_initials_snapshot text,
  created_by_name_snapshot     text NOT NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  version                      integer NOT NULL DEFAULT 1
                                 CONSTRAINT concrete_supplier_version_check CHECK (version >= 1),
  CONSTRAINT concrete_supplier_updated_check CHECK (updated_at >= created_at)
);

-- One listed supplier per name (case and surrounding spaces ignored), active or not.
CREATE UNIQUE INDEX concrete_supplier_name_key ON concrete_supplier (lower(name));

-- A supplier keeps its creation, is never deleted, and every change steps its version.
CREATE FUNCTION concrete_supplier_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concrete suppliers are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_supplier_no_delete';
  END IF;
  IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_by_name_snapshot <> OLD.created_by_name_snapshot
     OR NEW.created_by_initials_snapshot IS DISTINCT FROM OLD.created_by_initials_snapshot THEN
    RAISE EXCEPTION 'a concrete supplier keeps its creation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_supplier_fixed';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every concrete supplier change increments the version by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_supplier_version_step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_supplier_guard
  BEFORE UPDATE OR DELETE ON concrete_supplier
  FOR EACH ROW EXECUTE FUNCTION concrete_supplier_guard();

-- The optional link from a mix to a listed supplier. The mix's free-text supplier and plant names
-- stay the identity (and the uniqueness key); the link never renames anything.
ALTER TABLE concrete_mix ADD COLUMN supplier_id uuid REFERENCES concrete_supplier (id);
CREATE INDEX concrete_mix_supplier_idx ON concrete_mix (supplier_id) WHERE supplier_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Holiday calendar
-- ---------------------------------------------------------------------------------------------

CREATE TABLE company_holiday (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_on                   date NOT NULL,
  name                         text NOT NULL
                                 CONSTRAINT company_holiday_name_check
                                 CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  -- alberta_general: seeded from seed/reference.sql (fixed ids); company: added by an admin.
  source                       text NOT NULL
                                 CONSTRAINT company_holiday_source_check
                                 CHECK (source IN ('alberta_general', 'company')),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  -- NULL only for seeded reference rows.
  created_by_user_id           uuid REFERENCES app_user (id),
  created_by_initials_snapshot text,
  created_by_name_snapshot     text,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  -- Removal keeps the row (so a re-run of the reference seed never brings it back) and is final.
  removed_at                   timestamptz,
  removed_by_user_id           uuid REFERENCES app_user (id),
  removed_by_initials_snapshot text,
  removed_by_name_snapshot     text,
  removal_reason               text
                                 CONSTRAINT company_holiday_reason_check
                                 CHECK (removal_reason = btrim(removal_reason)
                                        AND length(removal_reason) BETWEEN 1 AND 2000),
  version                      integer NOT NULL DEFAULT 1
                                 CONSTRAINT company_holiday_version_check CHECK (version >= 1),
  CONSTRAINT company_holiday_updated_check CHECK (updated_at >= created_at),
  CONSTRAINT company_holiday_creator_check CHECK (
    (source = 'company') = (created_by_user_id IS NOT NULL AND created_by_name_snapshot IS NOT NULL)
    AND (created_by_user_id IS NOT NULL OR created_by_initials_snapshot IS NULL)
  ),
  CONSTRAINT company_holiday_removal_check CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_by_name_snapshot IS NULL
     AND removed_by_initials_snapshot IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL
        AND removed_by_name_snapshot IS NOT NULL AND removal_reason IS NOT NULL
        AND removed_at >= created_at)
  )
);

-- One holiday in effect per date.
CREATE UNIQUE INDEX company_holiday_date_key ON company_holiday (holiday_on)
  WHERE removed_at IS NULL;

-- A holiday keeps its date, source and creator; only the name changes, and removal is final.
CREATE FUNCTION company_holiday_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company holidays are never deleted; remove them instead'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'company_holiday_no_delete';
  END IF;
  IF NEW.id <> OLD.id OR NEW.holiday_on <> OLD.holiday_on OR NEW.source <> OLD.source
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_by_name_snapshot IS DISTINCT FROM OLD.created_by_name_snapshot
     OR NEW.created_by_initials_snapshot IS DISTINCT FROM OLD.created_by_initials_snapshot THEN
    RAISE EXCEPTION 'a company holiday keeps its date, source and creator'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_holiday_fixed';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed company holiday never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_holiday_removed_final';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every company holiday change increments the version by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_holiday_version_step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_holiday_guard
  BEFORE UPDATE OR DELETE ON company_holiday
  FOR EACH ROW EXECUTE FUNCTION company_holiday_guard();

CREATE FUNCTION concrete_reference_no_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete suppliers and company holidays are never truncated'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_reference_no_truncate';
END;
$$;

CREATE TRIGGER concrete_supplier_no_truncate
  BEFORE TRUNCATE ON concrete_supplier
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_reference_no_truncate();
CREATE TRIGGER company_holiday_no_truncate
  BEFORE TRUNCATE ON company_holiday
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_reference_no_truncate();

-- ---------------------------------------------------------------------------------------------
-- Mix draft discard
-- ---------------------------------------------------------------------------------------------

ALTER TABLE concrete_mix_revision
  ADD COLUMN discarded_at timestamptz,
  ADD COLUMN discarded_by_user_id uuid REFERENCES app_user (id),
  ADD COLUMN discarded_by_initials_snapshot text,
  ADD COLUMN discarded_by_name_snapshot text;

ALTER TABLE concrete_mix_revision
  DROP CONSTRAINT concrete_mix_revision_state_check,
  ADD CONSTRAINT concrete_mix_revision_state_check
    CHECK (state IN ('draft', 'approved', 'superseded', 'discarded'));

-- A discarded revision was a draft: never approved, and discarded by someone at a time.
ALTER TABLE concrete_mix_revision
  DROP CONSTRAINT concrete_mix_revision_approval_check,
  ADD CONSTRAINT concrete_mix_revision_approval_check CHECK (
    (state IN ('draft', 'discarded') AND approved_at IS NULL AND approved_by_user_id IS NULL
     AND approved_by_name_snapshot IS NULL AND approved_by_initials_snapshot IS NULL)
    OR (state IN ('approved', 'superseded') AND approved_at IS NOT NULL
        AND approved_by_user_id IS NOT NULL
        AND approved_by_name_snapshot IS NOT NULL AND approved_at >= created_at
        AND specified_strength_mpa IS NOT NULL AND slump_target_mm IS NOT NULL
        AND slump_tolerance_mm IS NOT NULL AND air_min_percent IS NOT NULL
        AND air_max_percent IS NOT NULL AND max_aggregate_size_mm IS NOT NULL
        AND cement_type IS NOT NULL)
  ),
  ADD CONSTRAINT concrete_mix_revision_discard_check CHECK (
    (state = 'discarded') = (discarded_at IS NOT NULL)
    AND (discarded_at IS NULL OR (discarded_by_user_id IS NOT NULL
                                  AND discarded_by_name_snapshot IS NOT NULL
                                  AND discarded_at >= created_at))
    AND (discarded_at IS NOT NULL OR (discarded_by_user_id IS NULL
                                      AND discarded_by_name_snapshot IS NULL
                                      AND discarded_by_initials_snapshot IS NULL))
  );

-- C03's guard, plus: a draft may become discarded, and a discarded revision never changes.
CREATE OR REPLACE FUNCTION concrete_mix_revision_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concrete mix revisions are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_mix_revision_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision_number <> (SELECT coalesce(max(revision_number), 0) + 1
                               FROM concrete_mix_revision WHERE mix_id = NEW.mix_id) THEN
      RAISE EXCEPTION 'concrete mix revisions are numbered in order without gaps'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_sequence';
    END IF;
    IF NEW.state <> 'draft' THEN
      RAISE EXCEPTION 'a concrete mix revision starts as a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_starts_draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.mix_id <> OLD.mix_id OR NEW.project_id <> OLD.project_id
     OR NEW.revision_number <> OLD.revision_number OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_by_name_snapshot <> OLD.created_by_name_snapshot
     OR NEW.created_by_initials_snapshot IS DISTINCT FROM OLD.created_by_initials_snapshot THEN
    RAISE EXCEPTION 'a concrete mix revision keeps its mix, number and creator'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_fixed';
  END IF;
  IF OLD.state = 'draft' THEN
    IF NEW.state = 'superseded' THEN
      RAISE EXCEPTION 'a draft is approved before it can be superseded'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_transition';
    END IF;
    -- Discarding keeps the draft's specification exactly as it was last saved.
    IF NEW.state = 'discarded'
       AND (to_jsonb(NEW) - 'state' - 'updated_at' - 'discarded_at' - 'discarded_by_user_id'
              - 'discarded_by_initials_snapshot' - 'discarded_by_name_snapshot')
           IS DISTINCT FROM
           (to_jsonb(OLD) - 'state' - 'updated_at' - 'discarded_at' - 'discarded_by_user_id'
              - 'discarded_by_initials_snapshot' - 'discarded_by_name_snapshot') THEN
      RAISE EXCEPTION 'a discarded draft keeps its last saved specification'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_discard_unchanged';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'discarded' THEN
    RAISE EXCEPTION 'a discarded concrete mix revision never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_discarded_final';
  END IF;
  -- Approved or superseded: the specification and approval are a permanent snapshot.
  IF NOT (OLD.state = 'approved' AND NEW.state = 'superseded')
     OR (to_jsonb(NEW) - 'state' - 'superseded_at' - 'updated_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'superseded_at' - 'updated_at') THEN
    RAISE EXCEPTION 'an approved concrete mix revision never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_revision_immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- The command ledger learns the discard kind.
ALTER TABLE concrete_mix_command
  DROP CONSTRAINT concrete_mix_command_kind_check,
  ADD CONSTRAINT concrete_mix_command_kind_check
    CHECK (kind IN ('create', 'edit', 'approve', 'copy', 'discard'));
