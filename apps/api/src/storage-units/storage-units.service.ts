import { Injectable } from '@nestjs/common';
import {
  STORAGE_UNIT_HISTORY_PAGE_SIZE,
  minimumRetainUntil,
  normalizeStorageUnitCode,
  type StorageUnitDetail,
  type StorageUnitHistoryPage,
  type StorageUnitLookupResponse,
} from '@trapezoid/shared';
import type { Pool } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { loadHoleSummaries } from './hole-summaries.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage unit by its UUID or readable ID (any case, surrounding spaces ignored). */
async function findUnit(
  pool: Pool,
  idOrCode: string,
): Promise<{ id: string; readable_id: string; receipt_id: string } | null> {
  const byUuid = UUID_PATTERN.test(idOrCode);
  const { rows } = await pool.query<{ id: string; readable_id: string; receipt_id: string }>(
    `SELECT id, readable_id, receipt_id FROM storage_unit WHERE ${byUuid ? 'id' : 'readable_id'} = $1`,
    [byUuid ? idOrCode : normalizeStorageUnitCode(idOrCode)],
  );
  return rows[0] ?? null;
}

/** Manual entry now, scanning later (T16/T17): trims and upper-cases, then exact match. */
export async function lookupStorageUnit(
  pool: Pool,
  code: string,
): Promise<StorageUnitLookupResponse | null> {
  const normalized = normalizeStorageUnitCode(code);
  if (normalized === '' || normalized.length > 40) return null;
  const { rows } = await pool.query<{ id: string; readable_id: string }>(
    'SELECT id, readable_id FROM storage_unit WHERE readable_id = $1',
    [normalized],
  );
  const unit = rows[0];
  return unit ? { id: unit.id, readableId: unit.readable_id } : null;
}

interface DetailRow {
  id: string;
  readable_id: string;
  unit_type: StorageUnitDetail['unitType'];
  status: StorageUnitDetail['status'];
  note: string | null;
  received_date: string;
  version: number;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  location_id: string;
  location_code: string;
  location_name: string;
  receipt_id: string;
  receipt_received_date: string;
  receipt_project_id: string;
  receipt_project_number: string;
  receipt_project_name: string;
  receipt_client: string;
  receiver_initials_snapshot: string;
  receiver_name_snapshot: string;
  account_initials: string | null;
  account_name: string;
  description: string | null;
  quantity: number;
  confirmed_at: Date;
}

export async function getStorageUnitDetail(
  pool: Pool,
  idOrCode: string,
): Promise<StorageUnitDetail | null> {
  const unit = await findUnit(pool, idOrCode);
  if (!unit) return null;
  const { rows } = await pool.query<DetailRow>(
    `SELECT su.id, su.readable_id, su.unit_type, su.status, su.note,
            su.received_date::text AS received_date, su.version,
            p.id AS project_id, p.project_number, p.name AS project_name, p.client,
            l.id AS location_id, l.code AS location_code, l.name AS location_name,
            r.id AS receipt_id, r.received_date::text AS receipt_received_date,
            rp.id AS receipt_project_id, rp.project_number AS receipt_project_number,
            rp.name AS receipt_project_name, rp.client AS receipt_client,
            r.receiver_initials_snapshot, r.receiver_name_snapshot,
            a.official_initials AS account_initials, a.display_name AS account_name,
            r.description, r.quantity, r.confirmed_at
     FROM storage_unit su
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     JOIN receipt r ON r.id = su.receipt_id
     JOIN project rp ON rp.id = r.project_id
     JOIN app_user a ON a.id = r.account_user_id
     WHERE su.id = $1`,
    [unit.id],
  );
  const row = rows[0]!;
  const holes = await loadHoleSummaries(pool, [row.id]);
  return {
    id: row.id,
    readableId: row.readable_id,
    unitType: row.unit_type,
    status: row.status,
    note: row.note,
    receivedDate: row.received_date,
    minimumRetainUntil: minimumRetainUntil(row.received_date),
    version: row.version,
    project: {
      id: row.project_id,
      projectNumber: row.project_number,
      name: row.project_name,
      client: row.client,
    },
    holes: holes.get(row.id) ?? [],
    location: { id: row.location_id, code: row.location_code, name: row.location_name },
    receipt: {
      id: row.receipt_id,
      receivedDate: row.receipt_received_date,
      project: {
        id: row.receipt_project_id,
        projectNumber: row.receipt_project_number,
        name: row.receipt_project_name,
        client: row.receipt_client,
      },
      receiver: { initials: row.receiver_initials_snapshot, name: row.receiver_name_snapshot },
      account: { initials: row.account_initials, name: row.account_name },
      description: row.description,
      quantity: row.quantity,
      confirmedAt: row.confirmed_at.toISOString(),
    },
  };
}

interface HistoryRow {
  id: string;
  occurred_at: Date;
  action: string;
  actor_initials_snapshot: string | null;
  actor_name_snapshot: string | null;
  actor_account_type: string | null;
  receiver_initials: string | null;
  receiver_name: string | null;
  reason: string | null;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
}

/**
 * Audit history of a unit, newest first and paged: its own events plus its receipt's
 * confirmation. Print jobs have their own section (print history, TRP-T15).
 */
export async function getStorageUnitHistory(
  pool: Pool,
  idOrCode: string,
  page: number,
): Promise<StorageUnitHistoryPage | null> {
  const unit = await findUnit(pool, idOrCode);
  if (!unit) return null;
  const pageSize = STORAGE_UNIT_HISTORY_PAGE_SIZE;
  const where = `(e.entity_type = 'storage_unit' AND e.entity_id = $1)
                 OR (e.entity_type = 'receipt' AND e.entity_id = $2)`;
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM audit_event e WHERE ${where}`,
    [unit.id, unit.receipt_id],
  );
  const { rows } = await pool.query<HistoryRow>(
    `SELECT e.id, e.occurred_at, e.action, e.actor_initials_snapshot, e.actor_name_snapshot,
            e.actor_account_type, r.official_initials AS receiver_initials,
            r.display_name AS receiver_name, e.reason, e.before_values, e.after_values
     FROM audit_event e
     LEFT JOIN app_user r ON r.id = e.receiver_user_id
     WHERE ${where}
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $3 OFFSET $4`,
    [unit.id, unit.receipt_id, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      action: row.action,
      actor: {
        initials: row.actor_initials_snapshot,
        name: row.actor_name_snapshot,
        accountType: row.actor_account_type,
      },
      receiver:
        row.receiver_name === null
          ? null
          : { initials: row.receiver_initials, name: row.receiver_name },
      reason: row.reason,
      before: row.before_values,
      after: row.after_values,
    })),
    total: count.rows[0]!.total,
    page,
    pageSize,
  };
}

@Injectable()
export class StorageUnitsService {
  constructor(private readonly database: DatabaseService) {}

  lookup(code: string) {
    return lookupStorageUnit(this.database.pool, code);
  }

  detail(idOrCode: string) {
    return getStorageUnitDetail(this.database.pool, idOrCode);
  }

  history(idOrCode: string, page: number) {
    return getStorageUnitHistory(this.database.pool, idOrCode, page);
  }
}
