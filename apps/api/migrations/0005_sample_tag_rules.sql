-- MM-T69 (decided by Kyle 2026-10-29): which tests share a printed sample ID tag is catalogue
-- data a Lab Manager maintains, not code. Each test entry is one of:
--   none:   no tag is printed for it (e.g. moisture content, visual identification);
--   own:    it always gets a tag of its own (the default: an unconfigured test is never combined);
--   shared: it shares one tag with the other tests of the same named group for the same sample
--           and depth.
-- Printing tags never writes to a program or request; this only describes how they are grouped.
ALTER TABLE test_type
  ADD COLUMN sample_tag_mode text NOT NULL DEFAULT 'own'
    CHECK (sample_tag_mode IN ('none', 'own', 'shared')),
  ADD COLUMN sample_tag_group text
    CHECK (sample_tag_group = btrim(sample_tag_group) AND length(sample_tag_group) BETWEEN 1 AND 60
           AND sample_tag_group !~ '[[:cntrl:]]'),
  -- A group name exactly when the test shares a tag.
  ADD CONSTRAINT test_type_sample_tag_shape_check
    CHECK ((sample_tag_mode = 'shared') = (sample_tag_group IS NOT NULL));
