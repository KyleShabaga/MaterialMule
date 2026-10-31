import {
  inventorySortDirection,
  splitInventorySearch,
  type InventoryQuery,
} from '@materialmule/shared';
import { likeEscape } from '../projects/projects.service.js';

/** Parameterised pieces of the inventory query. Values only ever travel as parameters. */
export interface InventorySql {
  /** FROM … WHERE …, shared by the count and the page query. */
  fromWhere: string;
  orderBy: string;
  params: unknown[];
  limit: number;
  offset: number;
}

/**
 * Builds the inventory query (MM-T12). Every search word must appear somewhere in the unit's
 * search document (AND across words, any field); filters combine with AND. The storage unit ID
 * always ends the sort so pages never overlap or skip rows that share a received date.
 */
export function buildInventoryQuery(
  query: InventoryQuery,
  options: { asOf?: string } = {},
): InventorySql {
  const params: unknown[] = [];
  const where: string[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const words = splitInventorySearch(query.search);
  for (const word of words) {
    // Backslash is LIKE's default escape character, which likeEscape uses.
    where.push(`s.document LIKE ${param(`%${likeEscape(word)}%`)}`);
  }
  if (query.projectId) {
    where.push(`su.project_id = ${param(query.projectId)}`);
  }
  if (query.testHoleId) {
    // Units from that hole: summarised per hole, a Shelby tube sourced from it, or a bulk bucket
    // whose group is sourced from it (MM-T36).
    const hole = param(query.testHoleId);
    where.push(
      `(EXISTS (SELECT 1 FROM storage_unit_hole_summary h
                WHERE h.storage_unit_id = su.id AND h.test_hole_id = ${hole})
        OR su.source_test_hole_id = ${hole}
        OR EXISTS (SELECT 1 FROM bulk_group g
                   WHERE g.id = su.bulk_group_id AND g.test_hole_id = ${hole}))`,
    );
  }
  if (query.type) {
    where.push(`su.unit_type = ${param(query.type)}`);
  }
  if (query.locationId) {
    where.push(`su.current_location_id = ${param(query.locationId)}`);
  }
  if (query.receiptId) {
    where.push(`su.receipt_id = ${param(query.receiptId)}`);
  }
  if (query.status === 'current') {
    where.push(`su.status <> 'disposed'`);
  } else if (query.status !== 'all') {
    where.push(`su.status = ${param(query.status)}`);
  }
  if (query.receivedFrom) {
    where.push(`su.received_date >= ${param(query.receivedFrom)}::date`);
  }
  if (query.receivedTo) {
    where.push(`su.received_date <= ${param(query.receivedTo)}::date`);
  }

  // MM-T29: the one retention calculation (unit_retention). "Eligible by date" is reached on the
  // effective retain-until date itself, in the business time zone.
  if (query.retention === 'on_hold') {
    where.push(`ur.active_hold_count > 0`);
  } else if (query.retention === 'eligible_by_date') {
    where.push(`ur.effective_retain_until <= ${param(options.asOf ?? null)}::date`);
  } else if (query.retention === 'eligible_for_disposal') {
    where.push(`unit_disposal_eligible(su.id, ${param(options.asOf ?? null)}::date)`);
  }

  // MM-T81: one open conflict per unit at most (location_conflict_one_open_idx).
  if (query.conflict === 'open') {
    where.push(
      `EXISTS (SELECT 1 FROM location_conflict c
               WHERE c.storage_unit_id = su.id AND c.status = 'open')`,
    );
  }

  const fromWhere = [
    'FROM storage_unit su',
    words.length > 0 ? 'JOIN storage_unit_search s ON s.storage_unit_id = su.id' : '',
    query.retention ? 'JOIN unit_retention ur ON ur.storage_unit_id = su.id' : '',
    where.length > 0 ? `WHERE ${where.join('\n  AND ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Direction comes from a closed enum, never from raw input.
  const dir = inventorySortDirection(query) === 'asc' ? 'ASC' : 'DESC';
  const orderBy =
    query.sort === 'received'
      ? `su.received_date ${dir}, su.readable_id COLLATE "C" ${dir}`
      : `su.readable_id COLLATE "C" ${dir}`;

  return {
    fromWhere,
    orderBy,
    params,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
}
