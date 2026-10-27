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
export function buildInventoryQuery(query: InventoryQuery): InventorySql {
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
    where.push(
      `EXISTS (SELECT 1 FROM storage_unit_hole_summary h
               WHERE h.storage_unit_id = su.id AND h.test_hole_id = ${param(query.testHoleId)})`,
    );
  }
  if (query.type) {
    where.push(`su.unit_type = ${param(query.type)}`);
  }
  if (query.locationId) {
    where.push(`su.current_location_id = ${param(query.locationId)}`);
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

  const fromWhere = [
    'FROM storage_unit su',
    words.length > 0 ? 'JOIN storage_unit_search s ON s.storage_unit_id = su.id' : '',
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
