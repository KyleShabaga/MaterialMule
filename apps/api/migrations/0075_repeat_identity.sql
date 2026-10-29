-- MM-T72: a repeat carries its original's current identity.
--
-- An accepted-request change (0051, D09) can give a request its own sample/depth in the override
-- columns. A repeat of that request must test the same sample and depth, so at creation it copies
-- the original's current test snapshot and all five override columns. A repeat of an unchanged
-- request keeps the overrides null and shows its line's identity. Enforced here: an inserted
-- repeat whose test snapshot or sample/depth differs from its original's is refused
-- (test_request_repeat_identity). Everything else in the guard is unchanged from 0051.

CREATE OR REPLACE FUNCTION test_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  program_status text;
  revising boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'test requests can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO program_status FROM lab_program WHERE id = NEW.program_id;
    IF NEW.repeat_of_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted' THEN
        RAISE EXCEPTION 'a repeat needs an open program' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM test_request o
                     WHERE o.id = NEW.repeat_of_id AND o.program_id = NEW.program_id
                       AND o.line_id = NEW.line_id AND o.test_type_id = NEW.test_type_id) THEN
        RAISE EXCEPTION 'a repeat must link to a request of the same line and test'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
      IF NOT EXISTS (
           SELECT 1 FROM test_request o
           WHERE o.id = NEW.repeat_of_id
             AND o.test_code_snapshot IS NOT DISTINCT FROM NEW.test_code_snapshot
             AND o.test_name_snapshot IS NOT DISTINCT FROM NEW.test_name_snapshot
             AND o.test_description_snapshot IS NOT DISTINCT FROM NEW.test_description_snapshot
             AND o.test_group_snapshot IS NOT DISTINCT FROM NEW.test_group_snapshot
             AND o.test_subgroup_snapshot IS NOT DISTINCT FROM NEW.test_subgroup_snapshot
             AND o.sample_label_override IS NOT DISTINCT FROM NEW.sample_label_override
             AND o.depth_mode_override IS NOT DISTINCT FROM NEW.depth_mode_override
             AND o.depth_from_override IS NOT DISTINCT FROM NEW.depth_from_override
             AND o.depth_to_override IS NOT DISTINCT FROM NEW.depth_to_override
             AND o.depth_unit_override IS NOT DISTINCT FROM NEW.depth_unit_override) THEN
        RAISE EXCEPTION 'a repeat keeps its original''s current test, sample and depth'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat_identity';
      END IF;
      IF NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'a repeat starts Requested'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'test_request_repeat';
      END IF;
    ELSIF NEW.amendment_id IS NOT NULL THEN
      IF program_status IS DISTINCT FROM 'submitted'
         OR NOT lab_amendment_program_matches(NEW.amendment_id, NEW.program_id)
         OR NEW.status <> 'requested' THEN
        RAISE EXCEPTION 'an amendment adds Requested tests to an open program only'
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF program_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'test requests are created when the program is submitted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  revising := NEW.identity_revision = OLD.identity_revision + 1
              AND OLD.status = 'accepted' AND NEW.status = 'requested';
  IF NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.repeat_of_id IS DISTINCT FROM OLD.repeat_of_id
     OR NEW.amendment_id IS DISTINCT FROM OLD.amendment_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
     OR NEW.identity_revision < OLD.identity_revision
     OR (NEW.identity_revision > OLD.identity_revision AND NOT revising)
     OR (NOT revising AND (
           NEW.test_type_id IS DISTINCT FROM OLD.test_type_id
           OR NEW.test_code_snapshot IS DISTINCT FROM OLD.test_code_snapshot
           OR NEW.test_name_snapshot IS DISTINCT FROM OLD.test_name_snapshot
           OR NEW.test_description_snapshot IS DISTINCT FROM OLD.test_description_snapshot
           OR NEW.test_group_snapshot IS DISTINCT FROM OLD.test_group_snapshot
           OR NEW.test_subgroup_snapshot IS DISTINCT FROM OLD.test_subgroup_snapshot
           OR NEW.sample_label_override IS DISTINCT FROM OLD.sample_label_override
           OR NEW.depth_mode_override IS DISTINCT FROM OLD.depth_mode_override
           OR NEW.depth_from_override IS DISTINCT FROM OLD.depth_from_override
           OR NEW.depth_to_override IS DISTINCT FROM OLD.depth_to_override
           OR NEW.depth_unit_override IS DISTINCT FROM OLD.depth_unit_override)) THEN
    RAISE EXCEPTION 'test request % snapshot is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
