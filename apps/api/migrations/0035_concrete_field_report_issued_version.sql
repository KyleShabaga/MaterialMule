-- Review fix (PR #127): an issued field report always names the version it last issued.
--
-- concrete_field_report_issue_shape (0015) compares last_issued_version BETWEEN 1 AND version in
-- its issued branch. A NULL version makes that branch UNKNOWN rather than false, and PostgreSQL
-- accepts a CHECK that is UNKNOWN, so issue_count > 0 with an issuer and a time but no version
-- was stored. This explicit, null-safe check closes that gap; the shape check stays as it is.

ALTER TABLE concrete_field_report
  ADD CONSTRAINT concrete_field_report_issued_has_version
  CHECK (issue_count = 0 OR last_issued_version IS NOT NULL);
