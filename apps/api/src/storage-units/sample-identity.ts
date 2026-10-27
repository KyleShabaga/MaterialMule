import type {
  BulkGroupMember,
  BulkGroupSummary,
  BulkMembership,
  SampleIdentity,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// Sample identity of Shelby tubes and bulk soil buckets (MM-T36), read the same way everywhere:
// a tube's own source/reference/depth, or a bulk bucket's group identity plus its "bucket n of N"
// place. n of N is worked out here, on every read, by received date then readable ID; it is never
// stored, so a later receipt or a membership correction renumbers every view at once.

/** Window over a group's members in display order. */
const MEMBER_ORDER = `PARTITION BY m.bulk_group_id ORDER BY m.received_date, m.readable_id COLLATE "C"`;

interface IdentityRow {
  source_type: 'test_hole' | 'standalone_location';
  test_hole_id: string | null;
  test_hole_name: string | null;
  location_reference: string | null;
  sample_reference: string | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
}

/** numeric(8, 2) arrives as a string; 1.50 shows as 1.5. */
const depth = (value: string | null) => (value === null ? null : Number(value));

export function toSampleIdentity(row: IdentityRow): SampleIdentity {
  return {
    source:
      row.source_type === 'test_hole'
        ? { type: 'test_hole', testHoleId: row.test_hole_id!, testHoleName: row.test_hole_name! }
        : { type: 'standalone_location', locationReference: row.location_reference! },
    sampleReference: row.sample_reference,
    depthFrom: depth(row.depth_from),
    depthTo: depth(row.depth_to),
    depthUnit: row.depth_unit,
  };
}

export interface UnitSampleIdentity {
  sample: SampleIdentity;
  bulkGroup: (BulkMembership & { description: string | null; version: number }) | null;
}

interface UnitIdentityRow extends IdentityRow {
  storage_unit_id: string;
  bulk_group_id: string | null;
  description: string | null;
  group_version: number | null;
  member_number: number | null;
  member_count: number | null;
}

/**
 * Sample identity of each given unit that has one, keyed by unit ID. Ordinary buckets (hole
 * summaries) and legacy tubes without a source are simply absent from the map.
 */
export async function loadSampleIdentities(
  pool: Pool | PoolClient,
  storageUnitIds: string[],
): Promise<Map<string, UnitSampleIdentity>> {
  const byUnit = new Map<string, UnitSampleIdentity>();
  if (storageUnitIds.length === 0) return byUnit;
  const { rows } = await pool.query<UnitIdentityRow>(
    `WITH units AS (
       SELECT * FROM storage_unit
       WHERE id = ANY ($1::uuid[]) AND (source_type IS NOT NULL OR bulk_group_id IS NOT NULL)
     ), ranked AS (
       SELECT m.id,
              row_number() OVER (${MEMBER_ORDER})::int AS member_number,
              count(*) OVER (PARTITION BY m.bulk_group_id)::int AS member_count
       FROM storage_unit m
       WHERE m.bulk_group_id IN (SELECT bulk_group_id FROM units WHERE bulk_group_id IS NOT NULL)
     )
     SELECT u.id AS storage_unit_id, g.id AS bulk_group_id,
            coalesce(g.source_type, u.source_type) AS source_type,
            th.id AS test_hole_id, th.name AS test_hole_name,
            coalesce(g.source_location_reference, u.source_location_reference) AS location_reference,
            CASE WHEN g.id IS NULL THEN u.sample_reference ELSE g.sample_reference END
              AS sample_reference,
            CASE WHEN g.id IS NULL THEN u.sample_depth_from ELSE g.depth_from END AS depth_from,
            CASE WHEN g.id IS NULL THEN u.sample_depth_to ELSE g.depth_to END AS depth_to,
            CASE WHEN g.id IS NULL THEN u.sample_depth_unit ELSE g.depth_unit END AS depth_unit,
            g.description, g.version AS group_version, r.member_number, r.member_count
     FROM units u
     LEFT JOIN bulk_group g ON g.id = u.bulk_group_id
     LEFT JOIN test_hole th ON th.id = coalesce(g.test_hole_id, u.source_test_hole_id)
     LEFT JOIN ranked r ON r.id = u.id`,
    [storageUnitIds],
  );
  for (const row of rows) {
    byUnit.set(row.storage_unit_id, {
      sample: toSampleIdentity(row),
      bulkGroup:
        row.bulk_group_id === null
          ? null
          : {
              groupId: row.bulk_group_id,
              memberNumber: row.member_number!,
              memberCount: row.member_count!,
              description: row.description,
              version: row.group_version!,
            },
    });
  }
  return byUnit;
}

/** The inventory row's "bucket n of N", without the group's description or version. */
export function membershipOf(identity: UnitSampleIdentity | undefined): BulkMembership | null {
  const group = identity?.bulkGroup;
  return group
    ? { groupId: group.groupId, memberNumber: group.memberNumber, memberCount: group.memberCount }
    : null;
}

/** Every bucket of a group in "n of N" order, with its own status and saved location. */
export async function loadBulkGroupMembers(
  pool: Pool | PoolClient,
  groupId: string,
): Promise<BulkGroupMember[]> {
  const { rows } = await pool.query<{
    id: string;
    readable_id: string;
    status: BulkGroupMember['status'];
    received_date: string;
    location_id: string;
    location_code: string;
    location_name: string;
  }>(
    `SELECT m.id, m.readable_id, m.status, m.received_date::text AS received_date,
            l.id AS location_id, l.code AS location_code, l.name AS location_name
     FROM storage_unit m
     JOIN location l ON l.id = m.current_location_id
     WHERE m.bulk_group_id = $1
     ORDER BY m.received_date, m.readable_id COLLATE "C"`,
    [groupId],
  );
  return rows.map((row) => ({
    id: row.id,
    readableId: row.readable_id,
    status: row.status,
    receivedDate: row.received_date,
    location: { id: row.location_id, code: row.location_code, name: row.location_name },
  }));
}

interface GroupRow extends IdentityRow {
  id: string;
  project_id: string;
  description: string | null;
  member_count: number;
  version: number;
}

const GROUP_SELECT = `
  SELECT g.id, g.project_id, g.source_type, g.test_hole_id, th.name AS test_hole_name,
         g.source_location_reference AS location_reference, g.sample_reference,
         g.depth_from, g.depth_to, g.depth_unit, g.description, g.version,
         (SELECT count(*)::int FROM storage_unit m WHERE m.bulk_group_id = g.id) AS member_count
  FROM bulk_group g
  LEFT JOIN test_hole th ON th.id = g.test_hole_id`;

function toGroupSummary(row: GroupRow): BulkGroupSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    identity: toSampleIdentity(row),
    description: row.description,
    memberCount: row.member_count,
    version: row.version,
  };
}

/**
 * A project's bulk groups for the receiving and correction pickers, ordered by source, sample
 * reference, then depth, so the two B1s of different holes sit apart and readable.
 */
export async function listProjectBulkGroups(
  pool: Pool | PoolClient,
  projectId: string,
): Promise<BulkGroupSummary[]> {
  const { rows } = await pool.query<GroupRow>(
    `${GROUP_SELECT}
     WHERE g.project_id = $1
     ORDER BY lower(coalesce(th.name, g.source_location_reference)), lower(g.sample_reference),
              g.depth_from, g.depth_to NULLS FIRST, g.created_at, g.id`,
    [projectId],
  );
  return rows.map(toGroupSummary);
}

/** One group by ID (any project), optionally locked; null when there is none. */
export async function findBulkGroup(
  pool: Pool | PoolClient,
  groupId: string,
  lock: '' | 'FOR SHARE OF g' | 'FOR UPDATE OF g' = '',
): Promise<BulkGroupSummary | null> {
  const { rows } = await pool.query<GroupRow>(`${GROUP_SELECT} WHERE g.id = $1 ${lock}`, [groupId]);
  return rows[0] ? toGroupSummary(rows[0]) : null;
}

/** A group's identity as audit events record it: readable, and complete enough to compare. */
export function identityAuditValue(
  group: Pick<BulkGroupSummary, 'id' | 'identity' | 'description'>,
) {
  return { id: group.id, ...group.identity, description: group.description };
}
