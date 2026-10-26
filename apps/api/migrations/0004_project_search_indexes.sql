-- TRP-T08: project and test-hole lookup while receiving.
-- The pickers search by prefix first ("679" -> 67997, "pine" -> Pine Creek). The unique and
-- lower(name) indexes from 0001 use the database collation, which LIKE 'abc%' can't use; these
-- pattern-ops indexes can. Contains-matches ("%pine%") scan, which is fine at the expected size
-- (thousands of projects, dozens of holes per project).

CREATE INDEX project_number_prefix_idx ON project (project_number_normalized text_pattern_ops);
CREATE INDEX project_name_prefix_idx ON project (lower(name) text_pattern_ops);
CREATE INDEX test_hole_name_prefix_idx ON test_hole (project_id, name_normalized text_pattern_ops);
