import { Injectable } from '@nestjs/common';
import {
  inventoryUsesStageTabs,
  type InventoryItem,
  type InventoryListItem,
  type InventoryListPage,
  type InventoryListQuery,
  type InventoryQuery,
  type InventoryStageCounts,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { loadHoleSummaries } from '../storage-units/hole-summaries.js';
import { loadSampleIdentities, membershipOf } from '../storage-units/sample-identity.js';
import { BusinessClock } from '../retention/business-clock.js';
import { loadUnitRetention } from '../retention/retention.js';
import {
  effectiveTermColumns,
  effectiveTermJoin,
  type EffectiveTermRow,
} from '../locations/storage-term.js';
import { buildInventoryQuery } from './inventory-query.js';
import { unitStage } from './unit-stage.js';

interface InventoryRow extends EffectiveTermRow {
  id: string;
  readable_id: string;
  unit_type: InventoryItem['unitType'];
  core_run_count: number | null;
  status: InventoryItem['status'];
  received_date: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  location_id: string;
  location_code: string;
  location_name: string;
  location_kind: string;
  tested_removal_reason: InventoryItem['testedRemovalReason'];
  contents_destroyed: boolean;
  open_conflict: boolean;
  location_path: string[];
}

/**
 * Every stage tab's count under the query's search and filters (STRATA-79): one aggregate over
 * the same FROM … WHERE, without the tab itself.
 */
export async function queryInventoryStageCounts(
  pool: Pool,
  query: InventoryQuery | InventoryListQuery,
  asOf: string,
): Promise<InventoryStageCounts> {
  const sql = buildInventoryQuery({ ...query, counts: true } as InventoryListQuery, {
    asOf,
    ignoreStage: true,
  });
  const tab = (statuses: string) =>
    `count(*) FILTER (WHERE rs.record_status IN (${statuses}))::int`;
  const { rows } = await pool.query<InventoryStageCounts>(
    `SELECT count(*)::int AS "all",
            ${tab(`'in_lab'`)} AS in_lab,
            ${tab(`'short_term'`)} AS short_term,
            ${tab(`'long_term'`)} AS long_term,
            ${tab(`'retention_due', 'retention_overdue'`)} AS retention_due,
            ${tab(`'disposed'`)} AS disposed,
            ${tab(`'location_conflict'`)} AS conflicts
     ${sql.fromWhere}`,
    sql.params,
  );
  return rows[0]!;
}

/**
 * One page of the inventory with its total (MM-T12). Never returns more than 100 units. With
 * `counts=1` it also returns every stage tab's count (STRATA-79).
 */
export async function queryInventory(
  pool: Pool,
  query: InventoryQuery | InventoryListQuery,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<InventoryListPage> {
  const sql = buildInventoryQuery(query, { asOf });
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total ${sql.fromWhere}`,
    sql.params,
  );
  const stageCounts =
    'counts' in query && query.counts === true && inventoryUsesStageTabs(query)
      ? await queryInventoryStageCounts(pool, query, asOf)
      : undefined;
  const limitParam = `$${sql.params.length + 1}`;
  const offsetParam = `$${sql.params.length + 2}`;
  const { rows } = await pool.query<InventoryRow>(
    `SELECT su.id, su.readable_id, su.unit_type, su.core_run_count, su.status, su.received_date::text AS received_date,
            p.id AS project_id, p.project_number, p.name AS project_name, p.client,
            l.id AS location_id, l.code AS location_code, l.name AS location_name,
            l.kind AS location_kind, tr.reason AS tested_removal_reason,
            (su.unit_type = 'shelby_tube'
             AND shelby_contents_destroyed_by_program(su.id) IS NOT NULL) AS contents_destroyed,
            EXISTS (SELECT 1 FROM location_conflict c
                    WHERE c.storage_unit_id = su.id AND c.status = 'open') AS open_conflict,
            array_remove(ARRAY[l2.name, l1.name, l.name], NULL) AS location_path,
            ${effectiveTermColumns('et')}
     FROM (SELECT su.id, row_number() OVER (ORDER BY ${sql.orderBy}) AS ord
           ${sql.fromWhere}
           ORDER BY ${sql.orderBy}
           LIMIT ${limitParam} OFFSET ${offsetParam}) page
     JOIN storage_unit su ON su.id = page.id
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     LEFT JOIN location l1 ON l1.id = l.parent_location_id
     LEFT JOIN location l2 ON l2.id = l1.parent_location_id
     ${effectiveTermJoin('et', 'l.id')}
     LEFT JOIN tested_unit_removal tr ON tr.storage_unit_id = su.id
     ORDER BY page.ord`,
    [...sql.params, sql.limit, sql.offset],
  );
  const ids = rows.map((row) => row.id);
  const holes = await loadHoleSummaries(pool, ids);
  const identities = await loadSampleIdentities(pool, ids);
  const retention = await loadUnitRetention(pool, ids, asOf);
  return {
    items: rows.map((row): InventoryListItem => ({
      // STRATA-58: record status words and stage from the unit's real state.
      ...unitStage({
        status: row.status,
        openConflict: row.open_conflict,
        locationKind: row.location_kind,
        storageTerm: row.effective_term,
        retention: retention.get(row.id),
        today: asOf,
      }),
      id: row.id,
      readableId: row.readable_id,
      unitType: row.unit_type,
      coreRunCount: row.core_run_count,
      status: row.status,
      receivedDate: row.received_date,
      project: {
        id: row.project_id,
        projectNumber: row.project_number,
        name: row.project_name,
        client: row.client,
      },
      holes: holes.get(row.id) ?? [],
      sample: identities.get(row.id)?.sample ?? null,
      bulkGroup: membershipOf(identities.get(row.id)),
      location: { id: row.location_id, code: row.location_code, name: row.location_name },
      // STRATA-79: warehouse › bay › shelf names for the Where column.
      locationPath: row.location_path,
      openConflict: row.open_conflict,
      // MM-T36: "Disposed after testing" and a tested Shelby tube's destroyed contents.
      testedRemovalReason: row.tested_removal_reason,
      contentsDestroyed: row.contents_destroyed,
      retention: ((r) =>
        r && {
          effectiveRetainUntil: r.effectiveRetainUntil,
          onHold: r.onHold,
          eligibleByDate: r.eligibleByDate,
          retentionExempt: r.retentionExempt,
        })(retention.get(row.id)),
    })),
    total: count.rows[0]!.total,
    page: query.page,
    pageSize: query.pageSize,
    ...(stageCounts ? { stageCounts } : {}),
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
  ) {}

  query(query: InventoryListQuery): Promise<InventoryListPage> {
    return queryInventory(this.database.pool, query, this.clock.today());
  }
}
