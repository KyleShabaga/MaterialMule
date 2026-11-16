-- STRATA-129: an optional comment on a lab program line (the requester's words for the lab about
-- that sample line, e.g. "Run the hydrometer on the finer half"). Progress only: a comment is
-- never a test result.
--
-- * Null when there is none; otherwise trimmed, not blank, at most 2000 characters (the program
--   notes' limit) and without control characters other than line breaks and tabs.
-- * It changes with the rest of the line: freely while the program is a draft, frozen from
--   submission (test_line_guard already refuses every update to a submitted program's lines).
--   A line an amendment adds carries its comment from the start and never changes afterwards.

ALTER TABLE test_line
  ADD COLUMN comment text,
  ADD CONSTRAINT test_line_comment_check CHECK (
    comment = btrim(comment)
    AND length(comment) BETWEEN 1 AND 2000
    AND comment !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
  );
