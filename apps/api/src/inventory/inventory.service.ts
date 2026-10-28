import { Injectable } from '@nestjs/common';
import type { InventoryItem, InventoryPage, InventoryQuery } from '@materialmule/shared';
import type { Pool } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { loadHoleSummaries } from '../storage-units/hole-summaries.js';
import { loadSampleIdentities, membershipOf } from '../storage-units/sample-identity.js';
import { BusinessClock } from '../retention/business-clock.js';
import { loadUnitRetention } from '../retention/retention.js';
import { buildInventoryQuery } from './inventory-query.js';

interface InventoryRow {
  id: string;
  readable_id: string;
  unit_type: InventoryItem['unitType'];
  status: InventoryItem['status'];
  received_date: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  location_id: string;
  location_code: string;
  location_name: string;
  tested_removal_reason: InventoryItem['testedRemovalReason'];
  contents_destroyed: boolean;
}

/** One page of the inventory with its total (MM-T12). Never returns more than 100 units. */
export async function queryInventory(
  pool: Pool,
  query: InventoryQuery,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<InventoryPage> {
  const sql = buildInventoryQuery(query, { asOf });
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total ${sql.fromWhere}`,
    sql.params,
  );
  const limitParam = `$${sql.params.length + 1}`;
  const offsetParam = `$${sql.params.length + 2}`;
  const { rows } = await pool.query<InventoryRow>(
    `SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date,
            p.id AS project_id, p.project_number, p.name AS project_name, p.client,
            l.id AS location_id, l.code AS location_code, l.name AS location_name,
            tr.reason AS tested_removal_reason,
            (su.unit_type = 'shelby_tube'
             AND shelby_contents_destroyed_by_program(su.id) IS NOT NULL) AS contents_destroyed
     FROM (SELECT su.id ${sql.fromWhere}
           ORDER BY ${sql.orderBy}
           LIMIT ${limitParam} OFFSET ${offsetParam}) page
     JOIN storage_unit su ON su.id = page.id
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     LEFT JOIN tested_unit_removal tr ON tr.storage_unit_id = su.id
     ORDER BY ${sql.orderBy}`,
    [...sql.params, sql.limit, sql.offset],
  );
  const ids = rows.map((row) => row.id);
  const holes = await loadHoleSummaries(pool, ids);
  const identities = await loadSampleIdentities(pool, ids);
  const retention = await loadUnitRetention(pool, ids, asOf);
  return {
    items: rows.map((row) => ({
      id: row.id,
      readableId: row.readable_id,
      unitType: row.unit_type,
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
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
  ) {}

  query(query: InventoryQuery): Promise<InventoryPage> {
    return queryInventory(this.database.pool, query, this.clock.today());
  }
}
