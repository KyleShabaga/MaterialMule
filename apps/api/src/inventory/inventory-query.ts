import {
  INVENTORY_STAGE_TAB_STATUSES,
  STORAGE_UNIT_RECORD_STATUSES,
  inventoryListSortDirection,
  inventorySearchWordForms,
  inventoryUsesStageTabs,
  splitInventorySearch,
  type InventoryListQuery,
  type InventoryQuery,
} from '@materialmule/shared';
import { likeEscape } from '../projects/projects.service.js';

/** Parameterised pieces of the inventory query. Values only ever travel as parameters. */
export interface InventorySql {
  /** FROM … WHERE …, shared by the count and the page query. */
  fromWhere: string;
  /** ORDER BY terms over the `fromWhere` aliases; the page query numbers its rows in this order. */
  orderBy: string;
  /** `rs.record_status` is available in `fromWhere` (stage tabs, counts or the stage sort). */
  hasRecordStatus: boolean;
  params: unknown[];
  limit: number;
  offset: number;
}

/**
 * Builds the inventory query (MM-T12, STRATA-79). Every search word must appear somewhere in the
 * unit's search document (AND across words, any field); filters combine with AND. The storage
 * unit ID always ends the sort so pages never overlap or skip rows that share a sort value.
 *
 * `ignoreStage` leaves the stage tab out (the counts query, which counts every tab under the same
 * search and filters).
 */
export function buildInventoryQuery(
  query: InventoryQuery | InventoryListQuery,
  options: { asOf?: string; ignoreStage?: boolean } = {},
): InventorySql {
  const list = query as Partial<InventoryListQuery> & InventoryQuery;
  const stageTabs = inventoryUsesStageTabs(list);
  const sort = list.sort as InventoryListQuery['sort'];
  const params: unknown[] = [];
  const where: string[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const words = splitInventorySearch(query.search);
  for (const word of words) {
    // Backslash is LIKE's default escape character, which likeEscape uses. A word matches as
    // typed or in its depth form (MTR-57).
    const forms = inventorySearchWordForms(word).map(
      (form) => `s.document LIKE ${param(`%${likeEscape(form)}%`)}`,
    );
    where.push(forms.length === 1 ? forms[0]! : `(${forms.join(' OR ')})`);
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
  // STRATA-79: with the stage tabs, the tab decides (below) and the older status filter is unused.
  if (!stageTabs) {
    if (query.status === 'current') {
      where.push(`su.status <> 'disposed'`);
    } else if (query.status !== 'all') {
      where.push(`su.status = ${param(query.status)}`);
    }
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

  // Field Ledger Retention bands: an effective retain-until range; tested units never match.
  const retainRange = Boolean(query.retainUntilFrom || query.retainUntilTo);
  if (retainRange) where.push('NOT ur.retention_exempt');
  if (query.retainUntilFrom) {
    where.push(`ur.effective_retain_until >= ${param(query.retainUntilFrom)}::date`);
  }
  if (query.retainUntilTo) {
    where.push(`ur.effective_retain_until <= ${param(query.retainUntilTo)}::date`);
  }

  // MM-T81: one open conflict per unit at most (location_conflict_one_open_idx).
  if (query.conflict === 'open') {
    where.push(
      `EXISTS (SELECT 1 FROM location_conflict c
               WHERE c.storage_unit_id = su.id AND c.status = 'open')`,
    );
  }

  // STRATA-79: the record status (STRATA-58's one rule) in SQL, so tabs, counts and the stage
  // sort all run on the server.
  const recordStatus = stageTabs || sort === 'stage';
  const joinRetention = Boolean(
    query.retention || retainRange || sort === 'retain_until' || recordStatus,
  );
  const joinLocation = recordStatus || sort === 'where';
  const today = recordStatus ? param(options.asOf ?? null) : '';
  if (stageTabs && list.stage && list.stage !== 'all' && !options.ignoreStage) {
    where.push(
      `rs.record_status = ANY(${param([...INVENTORY_STAGE_TAB_STATUSES[list.stage]])}::text[])`,
    );
  }

  const fromWhere = [
    'FROM storage_unit su',
    words.length > 0 ? 'JOIN storage_unit_search s ON s.storage_unit_id = su.id' : '',
    joinRetention ? 'JOIN unit_retention ur ON ur.storage_unit_id = su.id' : '',
    joinLocation ? 'JOIN location sl ON sl.id = su.current_location_id' : '',
    recordStatus
      ? 'LEFT JOIN location_effective_storage_term st ON st.location_id = su.current_location_id'
      : '',
    sort === 'project' ? 'JOIN project sp ON sp.id = su.project_id' : '',
    recordStatus ? `CROSS JOIN LATERAL (SELECT ${recordStatusSql(today)} AS record_status) rs` : '',
    where.length > 0 ? `WHERE ${where.join('\n  AND ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Direction comes from a closed enum, never from raw input.
  const dir = inventoryListSortDirection({ sort, dir: query.dir }) === 'asc' ? 'ASC' : 'DESC';
  const tie = `su.readable_id COLLATE "C" ${dir}`;
  let orderBy: string;
  switch (sort) {
    case 'received':
      orderBy = `su.received_date ${dir}, ${tie}`;
      break;
    case 'retain_until':
      orderBy = `ur.effective_retain_until ${dir} NULLS LAST, ${tie}`;
      break;
    case 'project':
      orderBy = `sp.project_number COLLATE "C" ${dir}, ${tie}`;
      break;
    case 'type':
      orderBy = `su.unit_type ${dir}, ${tie}`;
      break;
    case 'where':
      orderBy = `sl.code COLLATE "C" ${dir}, ${tie}`;
      break;
    case 'stage':
      // Lifecycle order of the record statuses (STRATA-58's list). Written into the SQL from the
      // shared constant, never from input, so the count query (which has no ORDER BY) and the
      // page query take the same parameters.
      orderBy = `array_position(ARRAY[${STORAGE_UNIT_RECORD_STATUSES.map((s) => `'${s}'`).join(', ')}]::text[], rs.record_status) ${dir}, ${tie}`;
      break;
    default:
      orderBy = tie;
  }

  return {
    fromWhere,
    orderBy,
    hasRecordStatus: recordStatus,
    params,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
}

/**
 * STRATA-58's record status rule as SQL over `su`, `sl` (saved location), `st` (its effective
 * storage term, view location_effective_storage_term) and `ur` (unit_retention); `today` is the
 * business date parameter. The same order as storageUnitRecordStatus and unitStageFacts:
 * disposed, open conflict, retention overdue, due, in lab, received (awaiting put-away),
 * long-term, else short-term (an unset term reads Short-term). Retention applies only without an
 * active hold and when the unit isn't exempt as tested.
 */
export function recordStatusSql(today: string): string {
  const applies = 'ur.active_hold_count = 0 AND NOT ur.retention_exempt';
  return `CASE
    WHEN su.status = 'disposed' THEN 'disposed'
    WHEN EXISTS (SELECT 1 FROM location_conflict c
                 WHERE c.storage_unit_id = su.id AND c.status = 'open') THEN 'location_conflict'
    WHEN ur.effective_retain_until < ${today}::date AND ${applies} THEN 'retention_overdue'
    WHEN ur.effective_retain_until <= ${today}::date AND ${applies} THEN 'retention_due'
    WHEN sl.kind = 'lab' THEN 'in_lab'
    WHEN sl.kind = 'receiving_lab' THEN 'received'
    WHEN st.term = 'long_term' THEN 'long_term'
    ELSE 'short_term'
  END`;
}
