-- MM-V2-C28: documenting a submitted version's exceptions, and the issuer's choices.
--
-- Combined Plan "Review interaction": Mark reviewed is offered once the required exceptions are
-- resolved or documented. A reviewer documents an exception (its code and field as frozen in the
-- version's snapshot) with a note on that version. Notes belong to the version: a resubmission is
-- a new version and needs its own review (Combined Plan section 9), so nothing carries forward.
-- Append-only: a note is never edited or removed; the version and its history keep it.
--
-- "Issuance workflow": the issuer chooses whether the issued report includes photos and the
-- testing machine information. The choice is stored on the issued version, set in the same update
-- that issues it (an issued version never changes afterwards, 0021), so the final layout (C32)
-- renders exactly what was chosen.

CREATE TABLE concrete_report_exception_note (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES project (id),
  field_report_id       uuid NOT NULL REFERENCES concrete_field_report (id),
  version_id            uuid NOT NULL,
  -- The exception code and field path as on the version's snapshot (C04/C05/C27 warning codes).
  code                  text NOT NULL
                          CONSTRAINT concrete_report_exception_note_code_check
                          CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  field                 text
                          CONSTRAINT concrete_report_exception_note_field_check
                          CHECK (length(btrim(field)) BETWEEN 1 AND 200),
  note                  text NOT NULL
                          CONSTRAINT concrete_report_exception_note_note_check
                          CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  documented_by_user_id uuid NOT NULL REFERENCES app_user (id),
  documented_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concrete_report_exception_note_version_fkey FOREIGN KEY (version_id, field_report_id)
    REFERENCES concrete_report_version (id, field_report_id)
);
-- One note per exception (code and field) per version.
CREATE UNIQUE INDEX concrete_report_exception_note_one
  ON concrete_report_exception_note (version_id, code, coalesce(field, ''));
CREATE INDEX concrete_report_exception_note_report_idx
  ON concrete_report_exception_note (field_report_id);
CREATE INDEX concrete_report_exception_note_project_idx
  ON concrete_report_exception_note (project_id);
CREATE INDEX concrete_report_exception_note_by_idx
  ON concrete_report_exception_note (documented_by_user_id);

-- A note is added only while its version awaits review, for that version's own report and project.
CREATE FUNCTION concrete_report_exception_note_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM concrete_report_version v
       WHERE v.id = NEW.version_id AND v.field_report_id = NEW.field_report_id
         AND v.project_id = NEW.project_id AND v.state = 'submitted') THEN
    RAISE EXCEPTION 'exceptions are documented on a version awaiting review'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'concrete_report_exception_note_open_version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concrete_report_exception_note_insert
  BEFORE INSERT ON concrete_report_exception_note
  FOR EACH ROW EXECUTE FUNCTION concrete_report_exception_note_insert();

CREATE FUNCTION concrete_report_exception_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'exception notes are append-only'
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'concrete_report_exception_note_append_only';
END;
$$;
CREATE TRIGGER concrete_report_exception_note_guard
  BEFORE UPDATE OR DELETE ON concrete_report_exception_note
  FOR EACH ROW EXECUTE FUNCTION concrete_report_exception_note_guard();
CREATE TRIGGER concrete_report_exception_note_no_truncate
  BEFORE TRUNCATE ON concrete_report_exception_note
  FOR EACH STATEMENT EXECUTE FUNCTION concrete_report_exception_note_guard();

-- The issuer's choices, present exactly when the version is issued. NOT VALID: rows issued before
-- this migration (pre-release test data only) have no recorded choice and stay as they were.
ALTER TABLE concrete_report_version
  ADD COLUMN issue_include_photos boolean,
  ADD COLUMN issue_include_machine_info boolean,
  ADD CONSTRAINT concrete_report_version_issue_options_shape CHECK (
    (issued_at IS NULL) = (issue_include_photos IS NULL)
    AND (issued_at IS NULL) = (issue_include_machine_info IS NULL)
  ) NOT VALID;
