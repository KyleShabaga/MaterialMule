-- MM-V2-C32: report numbers, template revisions and the issued report files.
--
-- Source: "V2 Concrete — Provisional report designs (G2, 2026-11-09)", owner-directed provisional
-- designs standing in for the office's report examples. Section 2: one gap-free counter per
-- report kind and year (year = issue date, America/Edmonton), allocated by the server at first
-- issue, inside the issue transaction; revisions keep the number; a number is never reused.
-- Section 1: render at issue from the frozen version snapshot, store the PDF with its SHA-256 and
-- the template revision, never regenerate (C32 AC1/AC2). Attachment storage (C15) isn't built, so
-- issued files are kept here as bytea behind the API's ReportFileStore, which C15 can replace.
--
-- Lock order: the issue command's locks (C09: report, version, project/accounts), then the
-- counter row (allocation), then the inserts below.

-- ---- Report-header setting (design section 1) ---------------------------------------------------
-- One row. The fictional default stands until the owner supplies branding; no accreditation marks.
CREATE TABLE concrete_report_header_setting (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  company_name        text NOT NULL DEFAULT 'Material Mule Testing Laboratory'
                        CONSTRAINT concrete_report_header_name_check
                        CHECK (length(btrim(company_name)) BETWEEN 1 AND 200),
  address             text
                        CONSTRAINT concrete_report_header_address_check
                        CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 500),
  phone               text
                        CONSTRAINT concrete_report_header_phone_check
                        CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 50),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES app_user (id)
);
INSERT INTO concrete_report_header_setting DEFAULT VALUES;

-- ---- Template revisions ----------------------------------------------------------------------------
-- One row per template revision and report kind. The revision in force for a kind is the one with
-- the latest in_force_from not after the issue time. Rows are never changed or removed: a new
-- design (the office examples, when supplied) is a new revision, and nothing issued under an
-- earlier one is rewritten. The P1 provisional revisions are seeded in seed/reference.sql.
CREATE TABLE concrete_report_template (
  id                 uuid PRIMARY KEY,
  report_kind        text NOT NULL
                       CONSTRAINT concrete_report_template_kind_check
                       CHECK (report_kind IN ('field', 'strength', 'summary')),
  revision           text NOT NULL
                       CONSTRAINT concrete_report_template_revision_check
                       CHECK (revision ~ '^[A-Z][A-Z0-9]{0,9}$'),
  name               text NOT NULL
                       CONSTRAINT concrete_report_template_name_check
                       CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  provisional        boolean NOT NULL,
  design_reference   text
                       CONSTRAINT concrete_report_template_design_check
                       CHECK (design_reference IS NULL OR length(btrim(design_reference)) BETWEEN 1 AND 500),
  in_force_from      timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_report_template_revision_key UNIQUE (report_kind, revision),
  CONSTRAINT concrete_report_template_kind_key UNIQUE (id, report_kind)
);
CREATE INDEX concrete_report_template_in_force_idx
  ON concrete_report_template (report_kind, in_force_from DESC);

CREATE FUNCTION concrete_report_template_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report template revisions never change'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_template_fixed';
END;
$$;
CREATE TRIGGER concrete_report_template_guard
  BEFORE UPDATE OR DELETE ON concrete_report_template
  FOR EACH ROW EXECUTE FUNCTION concrete_report_template_guard();
CREATE TRIGGER concrete_report_template_no_truncate
  BEFORE TRUNCATE ON concrete_report_template
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_template_guard();

-- ---- Report numbers (design section 2) --------------------------------------------------------------
-- The counter: one row per kind and year, raised by exactly one per allocation. Its row lock
-- serialises concurrent issues of the same kind and year; a rolled-back issue rolls the counter
-- back with it, so no number is skipped.
CREATE TABLE concrete_report_number_counter (
  report_kind   text NOT NULL
                  CONSTRAINT concrete_report_number_counter_kind_check
                  CHECK (report_kind IN ('field', 'strength', 'summary')),
  number_year   integer NOT NULL
                  CONSTRAINT concrete_report_number_counter_year_check
                  CHECK (number_year BETWEEN 2000 AND 9999),
  last_seq      integer NOT NULL
                  CONSTRAINT concrete_report_number_counter_seq_check CHECK (last_seq >= 1),
  PRIMARY KEY (report_kind, number_year)
);

CREATE FUNCTION concrete_report_number_counter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'report number counters are never removed'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_number_counter_kept';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_seq <> 1 THEN
      RAISE EXCEPTION 'a report number counter starts at 1'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_counter_step';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.report_kind IS DISTINCT FROM OLD.report_kind
     OR NEW.number_year IS DISTINCT FROM OLD.number_year
     OR NEW.last_seq <> OLD.last_seq + 1 THEN
    RAISE EXCEPTION 'a report number counter only steps up by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_counter_step';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_number_counter_guard
  BEFORE INSERT OR UPDATE OR DELETE ON concrete_report_number_counter
  FOR EACH ROW EXECUTE FUNCTION concrete_report_number_counter_guard();
CREATE TRIGGER concrete_report_number_counter_no_truncate
  BEFORE TRUNCATE ON concrete_report_number_counter
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_number_counter_guard();

-- One row per number ever issued. `subject_id` is what it numbers: the field report (every
-- revision keeps the number), the strength report (C39) or the summary report.
CREATE TABLE concrete_report_number (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind           text NOT NULL
                          CONSTRAINT concrete_report_number_kind_check
                          CHECK (report_kind IN ('field', 'strength', 'summary')),
  number_year           integer NOT NULL,
  seq                   integer NOT NULL
                          CONSTRAINT concrete_report_number_seq_check CHECK (seq >= 1),
  -- Set by the database from kind, year and seq: CF-YYYY-NNNNN, CS-YYYY-NNNNN, CSR-YYYY-NNNN.
  report_number         text NOT NULL,
  project_id            uuid NOT NULL REFERENCES project (id),
  subject_id            uuid NOT NULL,
  allocated_by_user_id  uuid NOT NULL REFERENCES app_user (id),
  allocated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_report_number_text_key UNIQUE (report_number),
  CONSTRAINT concrete_report_number_seq_key UNIQUE (report_kind, number_year, seq),
  -- At most one number per report: revisions keep it.
  CONSTRAINT concrete_report_number_subject_key UNIQUE (report_kind, subject_id),
  CONSTRAINT concrete_report_number_kind_key UNIQUE (id, report_kind),
  CONSTRAINT concrete_report_number_counter_fkey FOREIGN KEY (report_kind, number_year)
    REFERENCES concrete_report_number_counter (report_kind, number_year)
);
CREATE INDEX concrete_report_number_project_idx ON concrete_report_number (project_id);
CREATE INDEX concrete_report_number_allocated_by_idx ON concrete_report_number (allocated_by_user_id);

-- A number takes the counter's current value (the allocator raised it in this transaction), for
-- the issue date's year in America/Edmonton, in the kind's format.
CREATE FUNCTION concrete_report_number_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  counter_seq integer;
  width integer := CASE NEW.report_kind WHEN 'summary' THEN 4 ELSE 5 END;
BEGIN
  IF NEW.number_year <> extract(year FROM (NEW.allocated_at AT TIME ZONE 'America/Edmonton'))::integer THEN
    RAISE EXCEPTION 'a report number takes the issue date''s year (America/Edmonton)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_year';
  END IF;
  SELECT last_seq INTO counter_seq FROM concrete_report_number_counter
    WHERE report_kind = NEW.report_kind AND number_year = NEW.number_year;
  IF counter_seq IS DISTINCT FROM NEW.seq THEN
    RAISE EXCEPTION 'a report number takes the counter''s next value'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_from_counter';
  END IF;
  IF NEW.seq >= 10 ^ width THEN
    RAISE EXCEPTION 'the % report numbers for % are used up', NEW.report_kind, NEW.number_year
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_exhausted';
  END IF;
  NEW.report_number := CASE NEW.report_kind
                         WHEN 'field' THEN 'CF-' WHEN 'strength' THEN 'CS-' ELSE 'CSR-' END
                       || NEW.number_year || '-' || lpad(NEW.seq::text, width, '0');
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_number_insert
  BEFORE INSERT ON concrete_report_number
  FOR EACH ROW EXECUTE FUNCTION concrete_report_number_insert();

CREATE FUNCTION concrete_report_number_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report numbers are never changed, removed or reused'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_number_fixed';
END;
$$;
CREATE TRIGGER concrete_report_number_guard
  BEFORE UPDATE OR DELETE ON concrete_report_number
  FOR EACH ROW EXECUTE FUNCTION concrete_report_number_guard();
CREATE TRIGGER concrete_report_number_no_truncate
  BEFORE TRUNCATE ON concrete_report_number
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_number_guard();

-- Gap-free at commit: whatever raised the counter also used the value.
CREATE FUNCTION concrete_report_number_counter_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM concrete_report_number n
                 WHERE n.report_kind = NEW.report_kind AND n.number_year = NEW.number_year
                   AND n.seq = NEW.last_seq) THEN
    RAISE EXCEPTION '% report number % for % was counted but never issued',
      NEW.report_kind, NEW.last_seq, NEW.number_year
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_number_no_gap';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER concrete_report_number_counter_used
  AFTER INSERT OR UPDATE ON concrete_report_number_counter
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION concrete_report_number_counter_used();

-- ---- The issued version records its number and template --------------------------------------------
-- Set in the same update that issues the version (an issued version never changes, 0021).
ALTER TABLE concrete_report_version
  ADD COLUMN report_number_id uuid,
  ADD COLUMN report_template_id uuid,
  ADD COLUMN report_number_kind text GENERATED ALWAYS AS (report_kind) STORED,
  ADD CONSTRAINT concrete_report_version_number_fkey FOREIGN KEY (report_number_id, report_number_kind)
    REFERENCES concrete_report_number (id, report_kind),
  ADD CONSTRAINT concrete_report_version_template_fkey FOREIGN KEY (report_template_id, report_number_kind)
    REFERENCES concrete_report_template (id, report_kind),
  ADD CONSTRAINT concrete_report_version_output_shape CHECK (
    (report_number_id IS NULL) = (report_template_id IS NULL)
    AND (report_number_id IS NULL OR state = 'issued')
  );
CREATE INDEX concrete_report_version_number_idx
  ON concrete_report_version (report_number_id) WHERE report_number_id IS NOT NULL;
CREATE INDEX concrete_report_version_template_idx
  ON concrete_report_version (report_template_id) WHERE report_template_id IS NOT NULL;

-- A version's number is its own report's.
CREATE FUNCTION concrete_report_version_number_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.report_number_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM concrete_report_number n
       WHERE n.id = NEW.report_number_id AND n.subject_id = NEW.field_report_id
         AND n.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a version takes its own report''s number'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_own_number';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_version_number_check
  BEFORE INSERT OR UPDATE OF report_number_id ON concrete_report_version
  FOR EACH ROW EXECUTE FUNCTION concrete_report_version_number_check();

-- ---- Summary reports (design section 5) --------------------------------------------------------------
-- An issued project summary: the filters, the rows as printed (snapshot) and its hash. Each issue
-- is a new report with its own CSR number; nothing here changes afterwards.
CREATE TABLE concrete_summary_report (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES project (id),
  report_number_id    uuid NOT NULL,
  report_number_kind  text NOT NULL DEFAULT 'summary'
                        CONSTRAINT concrete_summary_report_kind_check CHECK (report_number_kind = 'summary'),
  filters             jsonb NOT NULL
                        CONSTRAINT concrete_summary_report_filters_check CHECK (jsonb_typeof(filters) = 'object'),
  snapshot            jsonb NOT NULL
                        CONSTRAINT concrete_summary_report_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_sha256     text NOT NULL,
  issued_by_user_id   uuid NOT NULL REFERENCES app_user (id),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  idempotency_key     uuid NOT NULL
                        CONSTRAINT concrete_summary_report_idempotency_key UNIQUE,
  request_hash        text NOT NULL,
  CONSTRAINT concrete_summary_report_number_key UNIQUE (report_number_id),
  CONSTRAINT concrete_summary_report_number_fkey FOREIGN KEY (report_number_id, report_number_kind)
    REFERENCES concrete_report_number (id, report_kind)
);
CREATE INDEX concrete_summary_report_project_idx ON concrete_summary_report (project_id, issued_at);
CREATE INDEX concrete_summary_report_issued_by_idx ON concrete_summary_report (issued_by_user_id);

CREATE FUNCTION concrete_summary_report_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM concrete_report_number n
                 WHERE n.id = NEW.report_number_id AND n.subject_id = NEW.id
                   AND n.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a summary report takes its own number'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_summary_report_own_number';
  END IF;
  NEW.snapshot_sha256 := encode(sha256(convert_to(NEW.snapshot::text, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_summary_report_insert
  BEFORE INSERT ON concrete_summary_report
  FOR EACH ROW EXECUTE FUNCTION concrete_summary_report_insert();

CREATE FUNCTION concrete_summary_report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued summary reports never change'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_summary_report_fixed';
END;
$$;
CREATE TRIGGER concrete_summary_report_guard
  BEFORE UPDATE OR DELETE ON concrete_summary_report
  FOR EACH ROW EXECUTE FUNCTION concrete_summary_report_guard();
CREATE TRIGGER concrete_summary_report_no_truncate
  BEFORE TRUNCATE ON concrete_summary_report
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_summary_report_guard();

-- ---- Issued files ------------------------------------------------------------------------------------
-- The exact bytes issued, with their SHA-256 (set by the database), the template revision, the
-- number and the issuer's choices. Each issue of a numbered report adds a file (Rev 0, Rev 1, …)
-- linked to the one it supersedes; files are never changed, removed or regenerated. Exported with
-- the project (C33). C15 may move the bytes to attachment storage behind the same interface.
CREATE TABLE concrete_report_file (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind           text NOT NULL
                          CONSTRAINT concrete_report_file_kind_check
                          CHECK (report_kind IN ('field', 'strength', 'summary')),
  project_id            uuid NOT NULL REFERENCES project (id),
  report_number_id      uuid NOT NULL,
  report_template_id    uuid NOT NULL,
  -- 0 for the first issue, then 1, 2 … (set by the database).
  revision_no           integer NOT NULL
                          CONSTRAINT concrete_report_file_revision_check CHECK (revision_no >= 0),
  supersedes_file_id    uuid REFERENCES concrete_report_file (id),
  -- What was rendered: an issued report version (field; strength with C39) or a summary report.
  report_version_id     uuid REFERENCES concrete_report_version (id),
  summary_report_id     uuid REFERENCES concrete_summary_report (id),
  media_type            text NOT NULL DEFAULT 'application/pdf'
                          CONSTRAINT concrete_report_file_media_type_check
                          CHECK (media_type = 'application/pdf'),
  file_name             text NOT NULL
                          CONSTRAINT concrete_report_file_name_check
                          CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.pdf$'),
  content               bytea NOT NULL
                          CONSTRAINT concrete_report_file_content_check CHECK (octet_length(content) > 0),
  byte_size             integer NOT NULL,
  sha256                text NOT NULL,
  include_photos        boolean NOT NULL,
  include_machine_info  boolean NOT NULL,
  created_by_user_id    uuid NOT NULL REFERENCES app_user (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_report_file_version_key UNIQUE (report_version_id),
  CONSTRAINT concrete_report_file_summary_key UNIQUE (summary_report_id),
  CONSTRAINT concrete_report_file_revision_key UNIQUE (report_number_id, revision_no),
  CONSTRAINT concrete_report_file_number_fkey FOREIGN KEY (report_number_id, report_kind)
    REFERENCES concrete_report_number (id, report_kind),
  CONSTRAINT concrete_report_file_template_fkey FOREIGN KEY (report_template_id, report_kind)
    REFERENCES concrete_report_template (id, report_kind),
  CONSTRAINT concrete_report_file_source_shape CHECK (
    (report_version_id IS NULL) <> (summary_report_id IS NULL)
    AND (report_kind = 'summary') = (summary_report_id IS NOT NULL)
  )
);
CREATE INDEX concrete_report_file_project_idx ON concrete_report_file (project_id, created_at);
CREATE INDEX concrete_report_file_template_idx ON concrete_report_file (report_template_id);
CREATE INDEX concrete_report_file_supersedes_idx
  ON concrete_report_file (supersedes_file_id) WHERE supersedes_file_id IS NOT NULL;
CREATE INDEX concrete_report_file_created_by_idx ON concrete_report_file (created_by_user_id);

-- Hash and size from the stored bytes; the revision number and the file it supersedes from the
-- number's earlier files; a version's file matches what the version records (number, template,
-- the issuer's choices) and is only for an issued version.
CREATE FUNCTION concrete_report_file_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
  v record;
BEGIN
  NEW.sha256 := encode(sha256(NEW.content), 'hex');
  NEW.byte_size := octet_length(NEW.content);
  SELECT id, revision_no INTO previous FROM concrete_report_file
    WHERE report_number_id = NEW.report_number_id ORDER BY revision_no DESC LIMIT 1;
  NEW.revision_no := coalesce(previous.revision_no + 1, 0);
  NEW.supersedes_file_id := previous.id;
  IF NEW.report_version_id IS NOT NULL THEN
    SELECT state, project_id, report_number_id, report_template_id, issue_include_photos,
           issue_include_machine_info
      INTO v FROM concrete_report_version WHERE id = NEW.report_version_id;
    IF v.state IS DISTINCT FROM 'issued' OR v.project_id <> NEW.project_id
       OR v.report_number_id IS DISTINCT FROM NEW.report_number_id
       OR v.report_template_id IS DISTINCT FROM NEW.report_template_id
       OR v.issue_include_photos IS DISTINCT FROM NEW.include_photos
       OR v.issue_include_machine_info IS DISTINCT FROM NEW.include_machine_info THEN
      RAISE EXCEPTION 'a report file is the issued version as recorded'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_file_matches_version';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM concrete_summary_report s
                    WHERE s.id = NEW.summary_report_id AND s.project_id = NEW.project_id
                      AND s.report_number_id = NEW.report_number_id) THEN
    RAISE EXCEPTION 'a report file is the summary report as issued'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_file_matches_summary';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_file_insert
  BEFORE INSERT ON concrete_report_file
  FOR EACH ROW EXECUTE FUNCTION concrete_report_file_insert();

CREATE FUNCTION concrete_report_file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued report files are never changed, removed or regenerated'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_file_fixed';
END;
$$;
CREATE TRIGGER concrete_report_file_guard
  BEFORE UPDATE OR DELETE ON concrete_report_file
  FOR EACH ROW EXECUTE FUNCTION concrete_report_file_guard();
CREATE TRIGGER concrete_report_file_no_truncate
  BEFORE TRUNCATE ON concrete_report_file
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_file_guard();

-- Every version issued with a template has its file by commit.
CREATE FUNCTION concrete_report_version_has_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.report_template_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM concrete_report_file f WHERE f.report_version_id = NEW.id) THEN
    RAISE EXCEPTION 'issued version % has no stored file', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_version_file_stored';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER concrete_report_version_has_file
  AFTER UPDATE OF report_template_id ON concrete_report_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION concrete_report_version_has_file();

-- A summary report has its file by commit.
CREATE FUNCTION concrete_summary_report_has_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM concrete_report_file f WHERE f.summary_report_id = NEW.id) THEN
    RAISE EXCEPTION 'summary report % has no stored file', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_summary_report_file_stored';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER concrete_summary_report_has_file
  AFTER INSERT ON concrete_summary_report
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION concrete_summary_report_has_file();
