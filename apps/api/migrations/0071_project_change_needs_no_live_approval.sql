-- MM-T70 (owner decision 2026-10-28: refuse): a unit's project can't change while it has a live
-- (not revoked, not used) disposal approval. The approval belongs to the project it was granted
-- under; revoke it on the Disposal & Retention page first, then correct the project. The API
-- refuses this with 422 disposal_approval_live; this trigger is the database backstop.
--
-- 0070's scan and removal guards stay as they are (defence in depth).

CREATE FUNCTION storage_unit_project_needs_no_live_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM disposal_approval a
             WHERE a.storage_unit_id = NEW.id AND a.revoked_at IS NULL AND a.used_at IS NULL) THEN
    RAISE EXCEPTION 'storage unit % is approved for disposal: revoke the approval before changing its project',
      NEW.readable_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storage_unit_project_disposal_approval_live';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storage_unit_project_needs_no_live_approval
  BEFORE UPDATE OF project_id ON storage_unit
  FOR EACH ROW
  WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION storage_unit_project_needs_no_live_approval();
