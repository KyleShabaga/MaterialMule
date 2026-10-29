-- MM-AO03: central authorization for project assignments and scoped grants (owner decisions D08,
-- D12, D15 of 2026-10-29). The first forward migration after the MM-AO02 baseline.

-- D12 (Kyle, 2026-10-29): the single "review engineer" field is retired. Scoped reviewer
-- assignments (project_reviewer_assignment) are the one source of reviewer responsibility and of
-- the "reviewer" reason in My projects, so there is never a second source of truth. Its values
-- are not carried into reviewer assignments: it never implied reviewer eligibility (D05), and
-- nothing was deployed. Past edits stay in audit_event ("project.updated").
DROP INDEX project_review_engineer_idx;
ALTER TABLE project DROP COLUMN review_engineer_user_id;

-- D12: My projects finds a person's acceptance delegations by person.
CREATE INDEX acceptance_delegation_delegate_idx
  ON acceptance_delegation (delegate_user_id) WHERE revoked_at IS NULL;

-- D15: every new acceptance delegation and every revocation carries a reason. Grants made before
-- reasons were required keep their null reason (nothing is invented for them) and can still be
-- revoked, with a reason. A trigger rather than a CHECK, because a CHECK would also refuse the
-- revocation of such a grant.
CREATE FUNCTION acceptance_delegation_reasons() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.grant_reason IS NULL THEN
    RAISE EXCEPTION 'an acceptance delegation needs a reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'acceptance_delegation_grant_reason_required';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revoked_at IS NOT NULL AND NEW.revoke_reason IS NULL THEN
    RAISE EXCEPTION 'revoking an acceptance delegation needs a reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'acceptance_delegation_revoke_reason_required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptance_delegation_reasons
  BEFORE INSERT OR UPDATE ON acceptance_delegation
  FOR EACH ROW EXECUTE FUNCTION acceptance_delegation_reasons();
