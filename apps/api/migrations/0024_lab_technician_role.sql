-- MM-V2-C36: the Lab Technician role (owner decisions, Kyle 2026-11-08).
--
-- Lab staff are the Lab Technician role, the Lab Manager role, and the shared LAB account naming
-- the performing staff member. Admins assign and remove `lab_technician` on the Accounts screen
-- through the existing role flow and audit (staff.roles_changed). Positions still grant nothing
-- (MISC-06).
--
-- Nothing else changes: every SQL helper and action-item rule that looks for a Lab Manager
-- compares `role = 'lab_manager'` exactly, and action_item.target_role stays limited to
-- 'lab_manager' and 'admin', so a Lab Technician is never treated as a Lab Manager. The shared
-- LAB account still holds no role (the staff service refuses one).

ALTER TABLE role_assignment DROP CONSTRAINT role_assignment_role_check;
ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_role_check
    CHECK (role IN ('admin', 'lab_manager', 'lab_technician'));
