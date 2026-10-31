-- MISC-03 (owner decision, Kyle 2026-10-30): an admin confirms a Lead Project Engineer
-- nomination without having to give a reason; one given is still recorded. Rejecting or
-- withdrawing a nomination keeps its required reason.
ALTER TABLE project_lead_nomination DROP CONSTRAINT project_lead_nomination_decision_check;
ALTER TABLE project_lead_nomination ADD CONSTRAINT project_lead_nomination_decision_check CHECK (
  (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL
   AND decided_by_initials_snapshot IS NULL AND decided_by_name_snapshot IS NULL
   AND decision_reason IS NULL)
  OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
      AND decided_by_name_snapshot IS NOT NULL
      AND (status = 'confirmed' OR decision_reason IS NOT NULL)
      AND decided_at >= nominated_at)
);
