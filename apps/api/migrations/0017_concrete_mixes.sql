-- MM-V2-C03: project concrete mixes, Lead Project Engineer approval and specification history.
--
-- A mix (CD-52) belongs to one project. Its specifications live in numbered revisions:
--   draft      : editable, not yet approved (a new or copied mix starts here: "Unapproved")
--   approved   : the revision in effect; never changes again
--   superseded : a former approved revision, replaced when the Lead approved a later one
-- D14 (adopted 2026-10-29, Option B): editing an approved mix makes a new draft revision; the
-- approved one stays in effect until the project's Lead Project Engineer approves the draft. So an
-- approved revision is a stable snapshot that later reports and specimen sets (C04/C05) reference
-- by id, and no registry edit can rewrite what they recorded (AC5).
--
-- Who may write is checked by the API (concrete_mix.manage / concrete_mix.approve: the project's
-- Lead Project Engineer only, AO08). Integrity is checked here and proven in
-- apps/api/src/db/schema-concrete-mixes.test.ts. Nothing here touches concrete_field_report,
-- concrete_specimen_set, concrete_specimen or concrete_project_settings, and no existing row
-- changes.

CREATE TABLE concrete_mix (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                   uuid NOT NULL REFERENCES project (id),
  -- The mix's identity as the latest revision states it (kept in step by the API in the same
  -- transaction), for the supplier filter and uniqueness. Identifiers are text: leading zeros kept.
  supplier_name                text NOT NULL
                                 CONSTRAINT concrete_mix_supplier_check
                                 CHECK (supplier_name = btrim(supplier_name)
                                        AND length(supplier_name) BETWEEN 1 AND 200),
  mix_number                   text NOT NULL
                                 CONSTRAINT concrete_mix_number_check
                                 CHECK (mix_number = btrim(mix_number)
                                        AND length(mix_number) BETWEEN 1 AND 100),
  -- The approved revision in effect (NULL: Unapproved) and the one open draft, if any.
  effective_revision_id        uuid,
  draft_revision_id            uuid,
  -- Copy provenance (card scope): the source revision, normally in another project. Copying never
  -- copies approval and never changes the source.
  copied_from_revision_id      uuid,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by_user_id           uuid NOT NULL REFERENCES app_user (id),
  created_by_initials_snapshot text,
  created_by_name_snapshot     text NOT NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  version                      integer NOT NULL DEFAULT 1
                                 CONSTRAINT concrete_mix_version_check CHECK (version >= 1),
  CONSTRAINT concrete_mix_project_id_key UNIQUE (project_id, id),
  CONSTRAINT concrete_mix_updated_check CHECK (updated_at >= created_at),
  CONSTRAINT concrete_mix_has_revision_check
    CHECK (effective_revision_id IS NOT NULL OR draft_revision_id IS NOT NULL),
  CONSTRAINT concrete_mix_pointers_distinct_check
    CHECK (effective_revision_id IS DISTINCT FROM draft_revision_id)
);

-- One mix per supplier and mix number in a project (case and surrounding spaces ignored).
CREATE UNIQUE INDEX concrete_mix_project_supplier_number_key
  ON concrete_mix (project_id, lower(supplier_name), lower(mix_number));

CREATE TABLE concrete_mix_revision (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id                        uuid NOT NULL,
  project_id                    uuid NOT NULL,
  revision_number               integer NOT NULL
                                  CONSTRAINT concrete_mix_revision_number_check
                                  CHECK (revision_number >= 1),
  state                         text NOT NULL DEFAULT 'draft'
                                  CONSTRAINT concrete_mix_revision_state_check
                                  CHECK (state IN ('draft', 'approved', 'superseded')),
  -- Project specification. NULL is "not entered yet", never zero (drafts always save).
  supplier_name                 text NOT NULL
                                  CHECK (supplier_name = btrim(supplier_name)
                                         AND length(supplier_name) BETWEEN 1 AND 200),
  mix_number                    text NOT NULL
                                  CHECK (mix_number = btrim(mix_number)
                                         AND length(mix_number) BETWEEN 1 AND 100),
  plant_names                   text[] NOT NULL DEFAULT '{}'
                                  CONSTRAINT concrete_mix_revision_plants_check
                                  CHECK (cardinality(plant_names) <= 20
                                         AND array_position(plant_names, NULL) IS NULL),
  specified_strength_mpa        numeric(6, 2)
                                  CONSTRAINT concrete_mix_revision_strength_check
                                  CHECK (specified_strength_mpa > 0),
  -- Optional, beside the strength, and separate from the specimen test ages.
  specified_strength_age_days   integer
                                  CONSTRAINT concrete_mix_revision_strength_age_check
                                  CHECK (specified_strength_age_days BETWEEN 1 AND 999),
  -- Slump = target ± tolerance (CD-17); 80 ± 30 mm is a format example, not a limit.
  slump_target_mm               numeric(6, 1)
                                  CONSTRAINT concrete_mix_revision_slump_check
                                  CHECK (slump_target_mm >= 0),
  slump_tolerance_mm            numeric(6, 1)
                                  CONSTRAINT concrete_mix_revision_slump_tolerance_check
                                  CHECK (slump_tolerance_mm >= 0),
  -- Air = min–max % (CD-17); 5–8 % is a format example, not a limit.
  air_min_percent               numeric(4, 1)
                                  CONSTRAINT concrete_mix_revision_air_min_check
                                  CHECK (air_min_percent BETWEEN 0 AND 100),
  air_max_percent               numeric(4, 1)
                                  CONSTRAINT concrete_mix_revision_air_max_check
                                  CHECK (air_max_percent BETWEEN 0 AND 100),
  max_aggregate_size_mm         numeric(6, 1)
                                  CONSTRAINT concrete_mix_revision_aggregate_check
                                  CHECK (max_aggregate_size_mm > 0),
  cement_type                   text
                                  CONSTRAINT concrete_mix_revision_cement_check
                                  CHECK (cement_type = btrim(cement_type)
                                         AND length(cement_type) BETWEEN 1 AND 100),
  -- Project-specification admixtures and the supplier-ticket defaults are separate (field map):
  -- shapes are the shared zod contracts (packages/shared/src/concrete-mixes.ts).
  spec_admixtures               jsonb NOT NULL DEFAULT '{"declaration": null, "items": []}'
                                  CONSTRAINT concrete_mix_revision_admixtures_check
                                  CHECK (jsonb_typeof(spec_admixtures) = 'object'),
  ticket_defaults               jsonb NOT NULL DEFAULT '{}'
                                  CONSTRAINT concrete_mix_revision_ticket_check
                                  CHECK (jsonb_typeof(ticket_defaults) = 'object'),
  -- One entry per specimen (days or HOLD; repeats are distinct entries), as C02's defaults.
  test_ages                     text[] NOT NULL DEFAULT '{7,28,28,HOLD}'
                                  CONSTRAINT concrete_mix_revision_ages_check
                                  CHECK (concrete_specimen_ages_valid(test_ages)),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  created_by_user_id            uuid NOT NULL REFERENCES app_user (id),
  created_by_initials_snapshot  text,
  created_by_name_snapshot      text NOT NULL,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  approved_at                   timestamptz,
  approved_by_user_id           uuid REFERENCES app_user (id),
  approved_by_initials_snapshot text,
  approved_by_name_snapshot     text,
  superseded_at                 timestamptz,
  CONSTRAINT concrete_mix_revision_mix_fkey FOREIGN KEY (project_id, mix_id)
    REFERENCES concrete_mix (project_id, id),
  CONSTRAINT concrete_mix_revision_mix_number_key UNIQUE (mix_id, revision_number),
  CONSTRAINT concrete_mix_revision_mix_id_key UNIQUE (mix_id, id),
  CONSTRAINT concrete_mix_revision_air_range_check CHECK (air_min_percent <= air_max_percent),
  -- Approved (or once approved) means approved by someone at a time, with the specification
  -- complete; the specified strength age stays optional (card AC1).
  CONSTRAINT concrete_mix_revision_approval_check CHECK (
    (state = 'draft' AND approved_at IS NULL AND approved_by_user_id IS NULL
     AND approved_by_name_snapshot IS NULL AND approved_by_initials_snapshot IS NULL)
    OR (state <> 'draft' AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL
        AND approved_by_name_snapshot IS NOT NULL AND approved_at >= created_at
        AND specified_strength_mpa IS NOT NULL AND slump_target_mm IS NOT NULL
        AND slump_tolerance_mm IS NOT NULL AND air_min_percent IS NOT NULL
        AND air_max_percent IS NOT NULL AND max_aggregate_size_mm IS NOT NULL
        AND cement_type IS NOT NULL)
  ),
  CONSTRAINT concrete_mix_revision_superseded_check CHECK (
    (state = 'superseded') = (superseded_at IS NOT NULL)
    AND (superseded_at IS NULL OR superseded_at >= approved_at)
  )
);

-- At most one open draft and one approved revision per mix.
CREATE UNIQUE INDEX concrete_mix_revision_one_draft_key
  ON concrete_mix_revision (mix_id) WHERE state = 'draft';
CREATE UNIQUE INDEX concrete_mix_revision_one_approved_key
  ON concrete_mix_revision (mix_id) WHERE state = 'approved';

-- The mix's pointers name its own revisions (deferred: a mix and its first revision are created
-- in one transaction).
ALTER TABLE concrete_mix
  ADD CONSTRAINT concrete_mix_effective_fkey FOREIGN KEY (id, effective_revision_id)
    REFERENCES concrete_mix_revision (mix_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT concrete_mix_draft_fkey FOREIGN KEY (id, draft_revision_id)
    REFERENCES concrete_mix_revision (mix_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT concrete_mix_copied_from_fkey FOREIGN KEY (copied_from_revision_id)
    REFERENCES concrete_mix_revision (id);

CREATE INDEX concrete_mix_copied_from_idx ON concrete_mix (copied_from_revision_id)
  WHERE copied_from_revision_id IS NOT NULL;

-- Revisions are numbered 1, 2, 3 … per mix with no gaps, and are never deleted. An approved or
-- superseded revision never changes, except approved → superseded when a later one is approved.
CREATE FUNCTION concrete_mix_revision_guard() RETURNS trigger
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
    RETURN NEW;
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

CREATE TRIGGER concrete_mix_revision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_mix_revision
  FOR EACH ROW EXECUTE FUNCTION concrete_mix_revision_guard();

-- A mix keeps its project and creation, is never deleted, and every change steps its version.
CREATE FUNCTION concrete_mix_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concrete mixes are never deleted'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_mix_no_delete';
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.copied_from_revision_id IS DISTINCT FROM OLD.copied_from_revision_id THEN
    RAISE EXCEPTION 'a concrete mix keeps its project, creator and copy source'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_fixed';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every concrete mix change increments the version by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_version_step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concrete_mix_guard
  BEFORE UPDATE OR DELETE ON concrete_mix
  FOR EACH ROW EXECUTE FUNCTION concrete_mix_guard();

CREATE FUNCTION concrete_mix_no_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete mixes and their revisions are never truncated'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_mix_no_truncate';
END;
$$;

CREATE TRIGGER concrete_mix_no_truncate
  BEFORE TRUNCATE ON concrete_mix
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_mix_no_truncate();
CREATE TRIGGER concrete_mix_revision_no_truncate
  BEFORE TRUNCATE ON concrete_mix_revision
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_mix_no_truncate();

-- At commit, the pointers agree with the revisions: the effective revision is the mix's one
-- approved revision (none: Unapproved) and the draft pointer is its one draft.
CREATE FUNCTION concrete_mix_check_pointers(target uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  m concrete_mix%ROWTYPE;
BEGIN
  SELECT * INTO m FROM concrete_mix WHERE id = target;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF m.effective_revision_id IS DISTINCT FROM
       (SELECT id FROM concrete_mix_revision WHERE mix_id = m.id AND state = 'approved')
     OR m.draft_revision_id IS DISTINCT FROM
       (SELECT id FROM concrete_mix_revision WHERE mix_id = m.id AND state = 'draft') THEN
    RAISE EXCEPTION 'a concrete mix points at its approved revision and its open draft'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_pointers';
  END IF;
  -- The mix's supplier and number are its latest revision's (the draft, else the approved one).
  IF NOT EXISTS (SELECT 1 FROM concrete_mix_revision r
                 WHERE r.id = coalesce(m.draft_revision_id, m.effective_revision_id)
                   AND r.supplier_name = m.supplier_name AND r.mix_number = m.mix_number) THEN
    RAISE EXCEPTION 'a concrete mix is named as its latest revision'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_mix_identity';
  END IF;
END;
$$;

CREATE FUNCTION concrete_mix_pointers_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM concrete_mix_check_pointers(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION concrete_mix_revision_pointers_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM concrete_mix_check_pointers(NEW.mix_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER concrete_mix_pointers
  AFTER INSERT OR UPDATE ON concrete_mix
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION concrete_mix_pointers_check();
CREATE CONSTRAINT TRIGGER concrete_mix_revision_pointers
  AFTER INSERT OR UPDATE ON concrete_mix_revision
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION concrete_mix_revision_pointers_check();

-- Exactly-once mix commands (create, edit, approve, copy): a retried request with the same key
-- and body returns the current mix without a second revision or audit event; the same key for a
-- different request is refused by the API (409 idempotency_key_reused). Append-only.
CREATE TABLE concrete_mix_command (
  idempotency_key  uuid PRIMARY KEY,
  mix_id           uuid NOT NULL REFERENCES concrete_mix (id),
  kind             text NOT NULL
                     CONSTRAINT concrete_mix_command_kind_check
                     CHECK (kind IN ('create', 'edit', 'approve', 'copy')),
  request_hash     text NOT NULL,
  user_id          uuid NOT NULL REFERENCES app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX concrete_mix_command_mix_idx ON concrete_mix_command (mix_id);

CREATE FUNCTION concrete_mix_command_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'concrete mix commands are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_mix_command_append_only';
END;
$$;

CREATE TRIGGER concrete_mix_command_guard
  BEFORE UPDATE OR DELETE ON concrete_mix_command
  FOR EACH ROW EXECUTE FUNCTION concrete_mix_command_guard();
