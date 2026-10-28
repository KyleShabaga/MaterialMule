import { UnprocessableEntityException } from '@nestjs/common';
import {
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  type CoverageUnit,
  type LabSource,
  type LabSourceRef,
  type LineScope,
  type MatchingBasis,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { loadSampleIdentities } from '../storage-units/sample-identity.js';

// Sampling sources and coverage of testing lines (MM-T23 pre-lab integration contract).
//
// Sources are explicit and project-scoped: a test hole, a standalone Shelby tube or a standalone
// bulk-sample group. Standalone locations are free text on each tube or group (MM-T36), so two
// with equal text stay two sources; nothing here matches sources by name.
//
// Candidates of a source are its units that still exist physically (not disposed):
//   test hole  → units with a summary for the hole, tubes sourced from it, buckets of bulk groups
//                sourced from it;
//   standalone → the tube itself, or the group's member buckets.
//
// Grabs / SPT: storage units carry no structured G/S classification today. A hole summary's
// sample range (G1–S12), a label prefix or a bulk group never proves what a unit holds, so every
// Grabs/SPT candidate is "unknown": excluded unless the requester explicitly reviewed and included
// it, and both outcomes are frozen. Nothing ever claims complete G/S coverage silently.

type Db = Pool | PoolClient;

export interface Candidate {
  storageUnitId: string;
  readableId: string;
  unitType: string;
  receiptId: string;
  receivedDate: string;
  contents: string | null;
  basis: Extract<
    MatchingBasis,
    'hole_summary' | 'tube_source' | 'bulk_group_source' | 'standalone_unit' | 'bulk_group_member'
  >;
}

interface CandidateRow {
  id: string;
  readable_id: string;
  unit_type: string;
  receipt_id: string;
  received_date: string;
  basis: Candidate['basis'];
  summary_type: 'all' | 'sample_range' | 'depth_range' | 'custom' | null;
  sample_from: string | null;
  sample_to: string | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
  custom_text: string | null;
  hole_name: string | null;
}

const UNIT_COLUMNS = `su.id, su.readable_id, su.unit_type, su.receipt_id,
                      to_char(su.received_date, 'YYYY-MM-DD') AS received_date`;
const NO_SUMMARY = `NULL::text AS summary_type, NULL::text AS sample_from, NULL::text AS sample_to,
                    NULL::numeric AS depth_from, NULL::numeric AS depth_to,
                    NULL::text AS depth_unit, NULL::text AS custom_text, NULL::text AS hole_name`;

export function sourceNotInProject(field = 'source'): never {
  throw new UnprocessableEntityException({
    code: 'source_not_in_project',
    errors: [
      {
        field,
        code: 'source_not_in_project',
        message: 'sampling source is not part of this project',
      },
    ],
  });
}

/** Every source a line can name in `projectId`, with how many units it currently covers. */
export async function listSources(db: Db, projectId: string): Promise<LabSource[]> {
  const { rows } = await db.query<{
    kind: LabSource['kind'];
    id: string;
    hole_name: string | null;
    location_reference: string | null;
    readable_id: string | null;
    sample_reference: string | null;
    depth_from: string | null;
    depth_to: string | null;
    depth_unit: 'ft' | 'm' | null;
    unit_count: number;
  }>(
    `SELECT 'test_hole' AS kind, th.id, th.name AS hole_name, NULL AS location_reference,
            NULL AS readable_id, NULL AS sample_reference, NULL::numeric AS depth_from,
            NULL::numeric AS depth_to, NULL AS depth_unit,
            (SELECT count(*)::int FROM storage_unit su
             WHERE su.project_id = th.project_id AND su.status <> 'disposed'
               AND (su.source_test_hole_id = th.id
                    OR EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                               WHERE h.storage_unit_id = su.id AND h.test_hole_id = th.id)
                    OR su.bulk_group_id IN (SELECT g.id FROM bulk_group g
                                            WHERE g.test_hole_id = th.id))) AS unit_count,
            1 AS kind_order, th.name_normalized AS sort_key
     FROM test_hole th WHERE th.project_id = $1
     UNION ALL
     SELECT 'standalone_unit', su.id, NULL, su.source_location_reference, su.readable_id,
            su.sample_reference, su.sample_depth_from, su.sample_depth_to, su.sample_depth_unit,
            1, 2, lower(su.source_location_reference) || ' ' || su.readable_id
     FROM storage_unit su
     WHERE su.project_id = $1 AND su.unit_type = 'shelby_tube'
       AND su.source_type = 'standalone_location' AND su.status <> 'disposed'
     UNION ALL
     SELECT 'standalone_bulk_group', g.id, NULL, g.source_location_reference, NULL,
            g.sample_reference, g.depth_from, g.depth_to, g.depth_unit,
            (SELECT count(*)::int FROM storage_unit su
             WHERE su.bulk_group_id = g.id AND su.status <> 'disposed'),
            3, lower(g.source_location_reference) || ' ' || lower(g.sample_reference)
     FROM bulk_group g
     WHERE g.project_id = $1 AND g.source_type = 'standalone_location'
     ORDER BY kind_order, sort_key, id`,
    [projectId],
  );
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    label: sourceLabel(row),
    unitCount: row.unit_count,
  }));
}

function sourceLabel(row: {
  kind: LabSource['kind'];
  hole_name: string | null;
  location_reference: string | null;
  readable_id: string | null;
  sample_reference: string | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
}): string {
  if (row.kind === 'test_hole') return row.hole_name!;
  const identity = formatSampleIdentity({
    source: { type: 'standalone_location', locationReference: row.location_reference! },
    sampleReference: row.sample_reference,
    depthFrom: row.depth_from === null ? null : Number(row.depth_from),
    depthTo: row.depth_to === null ? null : Number(row.depth_to),
    depthUnit: row.depth_unit,
  });
  return row.kind === 'standalone_unit'
    ? `${identity} · ${row.readable_id} (Shelby tube)`
    : `${identity} (bulk sample)`;
}

/**
 * The display label of `source` if it is a valid source of `projectId`; 422
 * `source_not_in_project` otherwise (another project's hole, an ordinary bucket, a tube with a
 * test-hole source, a group sourced from a hole, …).
 */
export async function resolveSource(
  db: Db,
  projectId: string,
  source: LabSourceRef,
  field = 'source',
): Promise<string> {
  const sources = await db.query<Partial<Parameters<typeof sourceLabel>[0]>>(
    source.kind === 'test_hole'
      ? `SELECT 'test_hole' AS kind, name AS hole_name FROM test_hole
         WHERE id = $1 AND project_id = $2`
      : source.kind === 'standalone_unit'
        ? `SELECT 'standalone_unit' AS kind, source_location_reference AS location_reference,
                  readable_id, sample_reference, sample_depth_from AS depth_from,
                  sample_depth_to AS depth_to, sample_depth_unit AS depth_unit
           FROM storage_unit
           WHERE id = $1 AND project_id = $2 AND unit_type = 'shelby_tube'
             AND source_type = 'standalone_location'`
        : `SELECT 'standalone_bulk_group' AS kind, source_location_reference AS location_reference,
                  sample_reference, depth_from, depth_to, depth_unit
           FROM bulk_group
           WHERE id = $1 AND project_id = $2 AND source_type = 'standalone_location'`,
    [source.id, projectId],
  );
  const row = sources.rows[0];
  if (!row) sourceNotInProject(field);
  return sourceLabel({
    kind: source.kind,
    hole_name: row.hole_name ?? null,
    location_reference: row.location_reference ?? null,
    readable_id: row.readable_id ?? null,
    sample_reference: row.sample_reference ?? null,
    depth_from: row.depth_from ?? null,
    depth_to: row.depth_to ?? null,
    depth_unit: row.depth_unit ?? null,
  });
}

/**
 * Units of `source` that still exist (not disposed), oldest first. `lock` takes FOR SHARE on each
 * unit so a concurrent project correction waits for the submission (and then sees its links).
 */
export async function sourceCandidates(
  db: Db,
  projectId: string,
  source: LabSourceRef,
  options: { lock?: boolean } = {},
): Promise<Candidate[]> {
  const live = `su.project_id = $2 AND su.status <> 'disposed'`;
  let sql: string;
  if (source.kind === 'test_hole') {
    sql = `SELECT ${UNIT_COLUMNS}, 'hole_summary' AS basis, h.summary_type, h.sample_from,
                  h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text,
                  th.name AS hole_name
           FROM storage_unit_hole_summary h
           JOIN storage_unit su ON su.id = h.storage_unit_id
           JOIN test_hole th ON th.id = h.test_hole_id
           WHERE h.test_hole_id = $1 AND ${live}
           UNION ALL
           SELECT ${UNIT_COLUMNS}, 'tube_source', ${NO_SUMMARY}
           FROM storage_unit su WHERE su.source_test_hole_id = $1 AND ${live}
           UNION ALL
           SELECT ${UNIT_COLUMNS}, 'bulk_group_source', ${NO_SUMMARY}
           FROM storage_unit su JOIN bulk_group g ON g.id = su.bulk_group_id
           WHERE g.test_hole_id = $1 AND ${live}`;
  } else if (source.kind === 'standalone_unit') {
    sql = `SELECT ${UNIT_COLUMNS}, 'standalone_unit' AS basis, ${NO_SUMMARY}
           FROM storage_unit su
           WHERE su.id = $1 AND su.unit_type = 'shelby_tube'
             AND su.source_type = 'standalone_location' AND ${live}`;
  } else {
    sql = `SELECT ${UNIT_COLUMNS}, 'bulk_group_member' AS basis, ${NO_SUMMARY}
           FROM storage_unit su
           WHERE su.bulk_group_id = $1 AND ${live}`;
  }
  if (options.lock) {
    await db.query(
      `SELECT su.id FROM storage_unit su WHERE su.id IN (SELECT id FROM (${sql}) c)
       ORDER BY su.id FOR SHARE OF su`,
      [source.id, projectId],
    );
  }
  const { rows } = await db.query<CandidateRow>(
    `SELECT * FROM (${sql}) c ORDER BY received_date, readable_id COLLATE "C"`,
    [source.id, projectId],
  );
  const identities = await loadSampleIdentities(
    db,
    rows.filter((row) => row.summary_type === null).map((row) => row.id),
  );
  return rows.map((row) => {
    const identity = identities.get(row.id);
    const contents =
      row.summary_type !== null
        ? `${row.hole_name}: ${formatStorageUnitHoleSummary({
            type: row.summary_type,
            sampleFrom: row.sample_from,
            sampleTo: row.sample_to,
            depthFrom: row.depth_from === null ? null : Number(row.depth_from),
            depthTo: row.depth_to === null ? null : Number(row.depth_to),
            depthUnit: row.depth_unit,
            customText: row.custom_text,
          })}`
        : identity
          ? formatSampleIdentity(identity.sample)
          : null;
    return {
      storageUnitId: row.id,
      readableId: row.readable_id,
      unitType: row.unit_type,
      receiptId: row.receipt_id,
      receivedDate: row.received_date,
      contents,
      basis: row.basis,
    };
  });
}

export interface LineCoverage {
  coverage: CoverageUnit[];
  /** Chosen units that aren't (or are no longer) units of the source. */
  strayChoices: string[];
  unknownClassificationCount: number;
}

/**
 * What submitting a line would freeze, given its candidates and explicit choices:
 *   ALL      → every candidate, with the basis it matched on;
 *   Grabs/SPT→ every candidate is G/S-unknown: included only when chosen after review
 *              (reviewed_included), otherwise frozen as unknown_classification_excluded;
 *   Specific → only the chosen units (explicit_selection); unknown units stay unlinked.
 */
export function lineCoverage(
  scope: LineScope,
  candidates: Candidate[],
  chosenUnitIds: string[],
): LineCoverage {
  const chosen = new Set(chosenUnitIds);
  const candidateIds = new Set(candidates.map((c) => c.storageUnitId));
  const strayChoices = chosenUnitIds.filter((id) => !candidateIds.has(id));
  const unit = (c: Candidate, included: boolean, basis: MatchingBasis): CoverageUnit => ({
    storageUnitId: c.storageUnitId,
    readableId: c.readableId,
    unitType: c.unitType,
    contents: c.contents,
    receivedDate: c.receivedDate,
    receiptId: c.receiptId,
    included,
    matchingBasis: basis,
  });
  switch (scope) {
    case 'all':
      return {
        coverage: candidates.map((c) => unit(c, true, c.basis)),
        strayChoices,
        unknownClassificationCount: 0,
      };
    case 'grabs':
    case 'spt':
      return {
        coverage: candidates.map((c) =>
          chosen.has(c.storageUnitId)
            ? unit(c, true, 'reviewed_included')
            : unit(c, false, 'unknown_classification_excluded'),
        ),
        strayChoices,
        unknownClassificationCount: candidates.length,
      };
    case 'specific':
      return {
        coverage: candidates
          .filter((c) => chosen.has(c.storageUnitId))
          .map((c) => unit(c, true, 'explicit_selection')),
        strayChoices,
        unknownClassificationCount: 0,
      };
  }
}
