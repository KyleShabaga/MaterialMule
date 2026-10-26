import { Injectable } from '@nestjs/common';
import type {
  InventoryItem,
  InventoryLocation,
  InventoryPage,
  InventoryQuery,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { loadHoleSummaries } from '../storage-units/hole-summaries.js';
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
}

/** One page of the inventory with its total (MM-T12). Never returns more than 100 units. */
export async function queryInventory(pool: Pool, query: InventoryQuery): Promise<InventoryPage> {
  const sql = buildInventoryQuery(query);
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total ${sql.fromWhere}`,
    sql.params,
  );
  const limitParam = `$${sql.params.length + 1}`;
  const offsetParam = `$${sql.params.length + 2}`;
  const { rows } = await pool.query<InventoryRow>(
    `SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date,
            p.id AS project_id, p.project_number, p.name AS project_name, p.client,
            l.id AS location_id, l.code AS location_code, l.name AS location_name
     FROM (SELECT su.id ${sql.fromWhere}
           ORDER BY ${sql.orderBy}
           LIMIT ${limitParam} OFFSET ${offsetParam}) page
     JOIN storage_unit su ON su.id = page.id
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     ORDER BY ${sql.orderBy}`,
    [...sql.params, sql.limit, sql.offset],
  );
  const holes = await loadHoleSummaries(
    pool,
    rows.map((row) => row.id),
  );
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
      location: { id: row.location_id, code: row.location_code, name: row.location_name },
    })),
    total: count.rows[0]!.total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Every location, active first, for the inventory location filter. Locations are few (T37). */
export async function listLocations(pool: Pool): Promise<InventoryLocation[]> {
  const { rows } = await pool.query<InventoryLocation>(
    `SELECT id, code, name, active FROM location ORDER BY active DESC, lower(name), code_normalized
     LIMIT 500`,
  );
  return rows;
}

@Injectable()
export class InventoryService {
  constructor(private readonly database: DatabaseService) {}

  query(query: InventoryQuery): Promise<InventoryPage> {
    return queryInventory(this.database.pool, query);
  }

  locations(): Promise<InventoryLocation[]> {
    return listLocations(this.database.pool);
  }
}
