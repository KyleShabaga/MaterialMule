-- MM-V2-C01: concrete domain aggregate roots (report → specimen set → specimen). Schema only: no
-- route, screen, allocator, submission, issuance or calculation uses these tables yet. Later cards
-- add their detailed fields through their own migrations (docs/concrete.md, "Field ownership").
--
-- A deliberate new domain. Concrete specimens are individual records, received one by one later
-- (C06). That does not relax the storage-unit rule: geotechnical receiving stays per storage unit
-- with no individual sample inventory, and nothing here touches storage_unit, its annual counters,
-- receipts or labels. Concrete identity never uses storage-unit IDs or counters.
--
-- Identity (spec page 3, CD-05–CD-12):
--   * Every row has an internal UUID that never changes. Clients may generate it offline, so a
--     retried sync of the same record is the same row (the sync card, C17, upserts on id).
--   * A set's temporary ID (TMP-<device code>-<local set counter>, CD-06) and permanent ID
--     (YY-NN, GYY-NN for grouts, CD-07/CD-11) are nullable aliases attached later; attaching one
--     never changes a UUID. A specimen's IDs are its set's IDs plus its letter (TMP-D07-001A,
--     27-03A), read from concrete_specimen_identity, never stored twice.
--   * Permanent numbers: one continuous counter per project for all materials (CD-07), so the
--     number is unique per project whatever the year or prefix. Allocation is C18's (never a
--     PostgreSQL sequence); this migration only keeps an attached number fixed and unreusable.
--
-- Statuses are separate dimensions (spec page 1): draft completeness is computed from the record,
-- never stored; workflow state and issuance are separate columns here; sync/acknowledgment lives
-- on the device and in the sync acknowledgment contract. See packages/shared/src/concrete.ts.

-- One field report = one sampled load / test (CD-13). Zero sets is valid.
CREATE TABLE concrete_field_report (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL REFERENCES project (id),
  -- The signed-in account that created the record (authority; may be a shared account).
  created_by_user_id       uuid NOT NULL REFERENCES app_user (id),
  -- The person who did the field work (attribution). Optional while a draft; a personal or test
  -- account, never a shared one (trigger below).
  technician_user_id       uuid REFERENCES app_user (id),
  -- Field work (spec page 1). Issued / Revised are the issuance columns, not workflow values.
  workflow_state           text NOT NULL DEFAULT 'draft'
                             CONSTRAINT concrete_field_report_workflow_state_check
                             CHECK (workflow_state IN ('draft', 'ready_to_submit', 'submitted',
                                                       'returned', 'reviewed', 'void')),
  -- CD-23: when the technician recorded Ready to submit (device time) and when the server
  -- submitted. C19 owns the transitions.
  ready_to_submit_at       timestamptz,
  submitted_at             timestamptz,
  -- Issuance (C09): how many times a version was issued, and the latest issue. 0 = never.
  issue_count              integer NOT NULL DEFAULT 0
                             CONSTRAINT concrete_field_report_issue_count_check CHECK (issue_count >= 0),
  last_issued_version      integer,
  last_issued_at           timestamptz,
  last_issued_by_user_id   uuid REFERENCES app_user (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer NOT NULL DEFAULT 1
                             CONSTRAINT concrete_field_report_version_check CHECK (version >= 1),
  CONSTRAINT concrete_field_report_project_id_key UNIQUE (project_id, id),
  CONSTRAINT concrete_field_report_ready_has_time
    CHECK (workflow_state <> 'ready_to_submit' OR ready_to_submit_at IS NOT NULL),
  -- A submitted time exists exactly when the report has been submitted.
  CONSTRAINT concrete_field_report_submitted_has_time CHECK (
    (workflow_state IN ('submitted', 'returned', 'reviewed')) = (submitted_at IS NOT NULL)
    OR (workflow_state = 'void')
  ),
  -- The latest issue is all there or all absent, and names a version that exists.
  CONSTRAINT concrete_field_report_issue_shape CHECK (
    (issue_count = 0 AND last_issued_version IS NULL AND last_issued_at IS NULL
       AND last_issued_by_user_id IS NULL)
    OR (issue_count > 0 AND last_issued_version BETWEEN 1 AND version
       AND last_issued_at IS NOT NULL AND last_issued_by_user_id IS NOT NULL)
  )
);
CREATE INDEX concrete_field_report_project_idx
  ON concrete_field_report (project_id, created_at DESC, id);
CREATE INDEX concrete_field_report_created_by_idx ON concrete_field_report (created_by_user_id);
CREATE INDEX concrete_field_report_technician_idx ON concrete_field_report (technician_user_id);
CREATE INDEX concrete_field_report_issued_by_idx ON concrete_field_report (last_issued_by_user_id);

-- A specimen set cast from one report's load. The schema sets no cap on sets per report.
CREATE TABLE concrete_specimen_set (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL,
  field_report_id    uuid NOT NULL,
  -- TMP-<device code>-<local set counter>, e.g. TMP-D07-001 (CD-06). Device codes are issued by
  -- the server and never reused (C12), so a temporary ID is unique everywhere.
  temporary_id       text
                       CONSTRAINT concrete_specimen_set_temporary_id_check
                       CHECK (temporary_id ~ '^TMP-[A-Z0-9]{1,16}-[0-9]{1,6}$'),
  -- YY-NN or GYY-NN (CD-07, CD-11): YY the casting year, NN the project counter, at least two
  -- digits. permanent_number is the counter value; both are set together, once.
  permanent_id       text
                       CONSTRAINT concrete_specimen_set_permanent_id_check
                       CHECK (permanent_id ~ '^G?[0-9]{2}-[0-9]{2,9}$'),
  permanent_number   integer
                       CONSTRAINT concrete_specimen_set_permanent_number_check
                       CHECK (permanent_number >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1
                       CONSTRAINT concrete_specimen_set_version_check CHECK (version >= 1),
  CONSTRAINT concrete_specimen_set_project_id_key UNIQUE (project_id, id),
  -- The set belongs to its report's project. ON UPDATE CASCADE carries a report's project
  -- correction down; the guard below refuses it once the set holds a permanent number.
  CONSTRAINT concrete_specimen_set_report_fkey FOREIGN KEY (project_id, field_report_id)
    REFERENCES concrete_field_report (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_specimen_set_permanent_parts CHECK (
    (permanent_id IS NULL) = (permanent_number IS NULL)
    AND (permanent_id IS NULL OR substring(permanent_id FROM '-([0-9]+)$')
         = lpad(permanent_number::text, greatest(2, length(permanent_number::text)), '0'))
  )
);
CREATE INDEX concrete_specimen_set_report_idx ON concrete_specimen_set (field_report_id);
CREATE UNIQUE INDEX concrete_specimen_set_temporary_id_key
  ON concrete_specimen_set (temporary_id) WHERE temporary_id IS NOT NULL;
-- One counter per project for all materials and years: a number is used once per project.
CREATE UNIQUE INDEX concrete_specimen_set_permanent_number_key
  ON concrete_specimen_set (project_id, permanent_number) WHERE permanent_number IS NOT NULL;
CREATE UNIQUE INDEX concrete_specimen_set_permanent_id_key
  ON concrete_specimen_set (project_id, permanent_id) WHERE permanent_id IS NOT NULL;

-- One physical specimen (cylinder, cube …), lettered A–Z within its set: at most 26 (CD-10).
CREATE TABLE concrete_specimen (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL,
  set_id      uuid NOT NULL,
  letter      text NOT NULL CONSTRAINT concrete_specimen_letter_check CHECK (letter ~ '^[A-Z]$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
                CONSTRAINT concrete_specimen_version_check CHECK (version >= 1),
  CONSTRAINT concrete_specimen_project_id_key UNIQUE (project_id, id),
  CONSTRAINT concrete_specimen_set_fkey FOREIGN KEY (project_id, set_id)
    REFERENCES concrete_specimen_set (project_id, id) ON UPDATE CASCADE,
  CONSTRAINT concrete_specimen_set_letter_key UNIQUE (set_id, letter)
);
CREATE INDEX concrete_specimen_project_idx ON concrete_specimen (project_id);

-- A specimen's aliases are its set's plus its letter, so they can never disagree.
CREATE VIEW concrete_specimen_identity AS
SELECT sp.id AS specimen_id,
       sp.set_id,
       sp.project_id,
       sp.letter,
       s.temporary_id || sp.letter AS temporary_id,
       s.permanent_id || sp.letter AS permanent_id
FROM concrete_specimen sp
JOIN concrete_specimen_set s ON s.id = sp.set_id;

-- The technician credited with field work is a person: an active personal or test account, never
-- a shared account (checked when set or changed; a later disable doesn't rewrite history).
CREATE FUNCTION concrete_field_report_technician_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.technician_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.technician_user_id IS DISTINCT FROM OLD.technician_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM app_user u
       WHERE u.id = NEW.technician_user_id AND u.status = 'active'
         AND u.account_type IN ('personal', 'test')
     ) THEN
    RAISE EXCEPTION 'a concrete technician must be an active personal account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_field_report_technician_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_report_technician_check
  BEFORE INSERT OR UPDATE OF technician_user_id ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_field_report_technician_check();

-- Internal UUIDs never change (CD-05 identity; cascades would otherwise carry a new id down).
CREATE FUNCTION concrete_id_is_stable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION '% % keeps its internal id', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_field_report_id_is_stable
  BEFORE UPDATE OF id ON concrete_field_report
  FOR EACH ROW EXECUTE FUNCTION concrete_id_is_stable();

-- Set identity: the id, the report and an attached alias never change; a permanent number is
-- never cleared, and its set can't change project or be deleted (the number stays in the
-- register and is never reused, CD-08). A set without a number may be deleted (a draft discarded
-- on the server); one with only a temporary ID keeps it.
CREATE FUNCTION concrete_specimen_set_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'concrete specimen sets can''t be truncated' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.permanent_number IS NOT NULL THEN
      RAISE EXCEPTION 'set % holds permanent number % and can''t be deleted', OLD.id, OLD.permanent_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.field_report_id IS DISTINCT FROM OLD.field_report_id THEN
    RAISE EXCEPTION 'set % keeps its id and report', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.temporary_id IS NOT NULL AND NEW.temporary_id IS DISTINCT FROM OLD.temporary_id THEN
    RAISE EXCEPTION 'set % keeps temporary ID %', OLD.id, OLD.temporary_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.permanent_number IS NOT NULL AND (
       NEW.permanent_number IS DISTINCT FROM OLD.permanent_number
       OR NEW.permanent_id IS DISTINCT FROM OLD.permanent_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    RAISE EXCEPTION 'set % keeps permanent ID % in its project', OLD.id, OLD.permanent_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_set_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen_set
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_set_guard();
CREATE TRIGGER concrete_specimen_set_no_truncate
  BEFORE TRUNCATE ON concrete_specimen_set
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_set_guard();

-- A specimen keeps its id and set. Once its set holds a permanent number the letter is written on
-- the specimen (CD-33), so it stays, and the specimen can't be deleted (Missing is a disposition,
-- not a deletion).
CREATE FUNCTION concrete_specimen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  numbered boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'concrete specimens can''t be truncated' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT s.permanent_number IS NOT NULL INTO numbered
  FROM concrete_specimen_set s WHERE s.id = OLD.set_id;
  IF TG_OP = 'DELETE' THEN
    IF numbered THEN
      RAISE EXCEPTION 'specimen % belongs to a numbered set and can''t be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.set_id IS DISTINCT FROM OLD.set_id THEN
    RAISE EXCEPTION 'specimen % keeps its id and set', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF numbered AND NEW.letter IS DISTINCT FROM OLD.letter THEN
    RAISE EXCEPTION 'specimen % keeps letter % in a numbered set', OLD.id, OLD.letter
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_specimen_guard
  BEFORE UPDATE OR DELETE ON concrete_specimen
  FOR EACH ROW EXECUTE FUNCTION concrete_specimen_guard();
CREATE TRIGGER concrete_specimen_no_truncate
  BEFORE TRUNCATE ON concrete_specimen
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_specimen_guard();
