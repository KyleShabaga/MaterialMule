-- MM-T59: inventory search matches SAMPLE#/DEPTH summaries exactly as the app displays them.
--
-- The app shows ranges with an en dash ("TH26-01: G1–S10", "TH26-01: 3–5 ft"), but the 0010
-- document held a sample range only as "g1 s10 g1-s10" and a depth range only as "3 5 ft", so
-- text copied from the table found nothing. This version of storage_unit_search_document:
--   * adds the joined depth form ("3-5 ft") next to the separate ends;
--   * adds each hole as displayed, "<test hole>: <summary>" ("th26-01: g1-s10");
--   * folds every dash in the whole document to "-": hyphens U+2010/U+2011, figure/en/em dashes
--     and the horizontal bar U+2012–U+2015, the minus sign U+2212, and the small and full-width
--     hyphens U+FE58/U+FE63/U+FF0D. splitInventorySearch (packages/shared/src/inventory.ts) folds
--     search words with exactly the same set, so "G1–S10", "G1-S10" and "G1−S10" all match.
-- Everything else in the document is unchanged (ID, type, note, project, location, test-hole
-- names, Custom text, summary notes), so existing searches keep working.
--
-- MM-T36 (Shelby tubes and bulk groups) will redefine this same function again to add bulk
-- references and sampling sources. It must start from THIS version (not 0010's) and keep the dash
-- folding and the displayed-summary forms, then rebuild the documents the same way as below.
--
-- Only the function changes: refresh_storage_unit_search and the triggers call it by name, and
-- the trigram index covers the stored document, so rebuilding the stored documents is enough.

CREATE OR REPLACE FUNCTION storage_unit_search_document(unit_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT translate(
    lower(concat_ws(E'\n',
      su.readable_id,
      replace(su.unit_type, '_', ' '),
      su.note,
      p.project_number,
      p.name,
      p.client,
      l.code,
      l.name,
      (SELECT string_agg(concat_ws(E'\n',
                th.name,
                CASE h.summary_type
                  WHEN 'all' THEN 'all'
                  WHEN 'sample_range' THEN h.sample_from || ' ' || h.sample_to || ' '
                                           || h.sample_from || '-' || h.sample_to
                  WHEN 'depth_range' THEN trim_scale(h.depth_from)::text || ' '
                                          || trim_scale(h.depth_to)::text || ' ' || h.depth_unit
                                          || E'\n' || trim_scale(h.depth_from)::text || '-'
                                          || trim_scale(h.depth_to)::text || ' ' || h.depth_unit
                END,
                -- As formatStorageUnitHoleSummary shows it after the test-hole name.
                th.name || ': ' || CASE h.summary_type
                  WHEN 'all' THEN 'all'
                  WHEN 'sample_range' THEN concat(h.sample_from, '-', h.sample_to)
                  WHEN 'depth_range' THEN trim(concat(trim_scale(h.depth_from)::text, '-',
                                               trim_scale(h.depth_to)::text, ' ', h.depth_unit))
                  WHEN 'custom' THEN coalesce(h.custom_text, '')
                END,
                h.custom_text,
                h.note), E'\n' ORDER BY th.name_normalized)
       FROM storage_unit_hole_summary h
       JOIN test_hole th ON th.id = h.test_hole_id
       WHERE h.storage_unit_id = su.id))),
    U&'\2010\2011\2012\2013\2014\2015\2212\FE58\FE63\FF0D',
    '----------')
  FROM storage_unit su
  JOIN project p ON p.id = su.project_id
  JOIN location l ON l.id = su.current_location_id
  WHERE su.id = unit_id
$$;

-- Rebuild every stored document with the new definition.
SELECT refresh_storage_unit_search(ARRAY(SELECT id FROM storage_unit));
