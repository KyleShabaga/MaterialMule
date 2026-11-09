-- MM-V2-C31: Concrete search indexes (card section 4: "bounded queries, indexes on IDs and
-- ticket numbers"). Indexes only: no table, column, rule or data changes.
--
-- Concrete search (GET /api/concrete/search) matches a set ID exactly or from its start across
-- every project (a readable set number repeats between projects, so the existing
-- (project_id, permanent_id) key can't serve it), a ticket number without its supplier (the
-- existing ticket index leads with the supplier), the paper Field ID and the casting date.
-- text_pattern_ops lets the prefix searches (LIKE 'x%') use the index under any collation.

CREATE INDEX concrete_specimen_set_permanent_id_search_idx
  ON concrete_specimen_set (permanent_id text_pattern_ops) WHERE permanent_id IS NOT NULL;
CREATE INDEX concrete_specimen_set_temporary_id_search_idx
  ON concrete_specimen_set (temporary_id text_pattern_ops) WHERE temporary_id IS NOT NULL;

CREATE INDEX concrete_field_report_ticket_search_idx
  ON concrete_field_report (lower(btrim(ticket_number)) text_pattern_ops)
  WHERE ticket_number IS NOT NULL;
CREATE INDEX concrete_field_report_paper_field_id_search_idx
  ON concrete_field_report (lower(btrim(paper_field_id)) text_pattern_ops)
  WHERE paper_field_id IS NOT NULL;
CREATE INDEX concrete_field_report_cast_at_idx
  ON concrete_field_report (cast_at) WHERE cast_at IS NOT NULL;
