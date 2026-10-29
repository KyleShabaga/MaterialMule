-- TRP-T35: projects list and project detail.
--
-- The list searches project number, name and client (contains, ignoring case), filters "Only
-- mine" (Lead Project Engineer or review engineer) and shows per-project counts computed by query. Trigram
-- indexes serve the contains search; the counts use the existing receipt_project_idx and
-- storage_unit_project_status_idx.

CREATE INDEX project_number_trgm_idx ON project USING gin (project_number_normalized public.gin_trgm_ops);
CREATE INDEX project_name_trgm_idx ON project USING gin (lower(name) public.gin_trgm_ops);
CREATE INDEX project_client_trgm_idx ON project USING gin (lower(client) public.gin_trgm_ops);

CREATE INDEX project_lead_project_engineer_idx ON project (lead_project_engineer_user_id);
CREATE INDEX project_review_engineer_idx ON project (review_engineer_user_id)
  WHERE review_engineer_user_id IS NOT NULL;

-- The project number is printed on storage unit labels, so it can't change once any receipt
-- exists for the project (owner decision 2026-10-25). The API answers 422 first; this is the
-- backstop. Changing the number rewrites the unique key, so the UPDATE's row lock conflicts with
-- the key-share lock a concurrent receipt insert takes on the project, and the check below sees
-- that receipt once it commits.
CREATE FUNCTION project_number_locked_after_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_number IS DISTINCT FROM OLD.project_number
     AND EXISTS (SELECT 1 FROM receipt WHERE project_id = OLD.id) THEN
    RAISE EXCEPTION 'project % number is printed on existing labels', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_number_locked
  BEFORE UPDATE OF project_number ON project
  FOR EACH ROW EXECUTE FUNCTION project_number_locked_after_receipt();
