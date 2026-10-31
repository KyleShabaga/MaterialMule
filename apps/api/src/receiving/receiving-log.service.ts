import { Injectable } from '@nestjs/common';
import {
  RECEIPT_LOG_RECEIVER_LIMIT,
  receiptLogUnitCode,
  splitReceiptLogSearch,
  type ReceiptDetail,
  type ReceiptLogItem,
  type ReceiptLogPage,
  type ReceiptLogQuery,
  type ReceiptReceiverQuery,
  type ReceiptUnit,
  type ReceiverOption,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { likeEscape } from '../projects/projects.service.js';
import { loadHoleSummaries } from '../storage-units/hole-summaries.js';
import { loadSampleIdentities, membershipOf } from '../storage-units/sample-identity.js';

// Receiving Log (MM-T51): read-only views of confirmed receipts. Nothing here writes, audits or
// queues printing. Each receipt is one row: the list never joins its storage units, so a
// multi-unit receipt can't repeat or inflate the counts.

/** Parameterised WHERE clause of the receipt list. Values only ever travel as parameters. */
export function buildReceiptLogWhere(query: ReceiptLogQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const words = splitReceiptLogSearch(query.search);
  if (words.length > 0) {
    // Every word must match the project number or name, or the receiver's snapshot name or
    // initials (AND across words); or the whole search is one of the receipt's storage unit IDs,
    // found once through the unique readable_id rather than per receipt.
    const wordMatches = words.map((word) => {
      const like = param(`%${likeEscape(word)}%`);
      return `(p.project_number_normalized LIKE ${like} OR lower(p.name) LIKE ${like}
               OR lower(r.receiver_name_snapshot) LIKE ${like}
               OR lower(r.receiver_initials_snapshot) LIKE ${like})`;
    });
    where.push(
      `((${wordMatches.join(' AND ')})
        OR r.id IN (SELECT su.receipt_id FROM storage_unit su
                    WHERE su.readable_id = ${param(receiptLogUnitCode(query.search))}))`,
    );
  }
  if (query.projectId) where.push(`r.project_id = ${param(query.projectId)}`);
  if (query.receiverUserId) where.push(`r.receiver_user_id = ${param(query.receiverUserId)}`);
  if (query.receivedFrom) where.push(`r.received_date >= ${param(query.receivedFrom)}::date`);
  if (query.receivedTo) where.push(`r.received_date <= ${param(query.receivedTo)}::date`);
  return { where: where.length > 0 ? `WHERE ${where.join('\n  AND ')}` : '', params };
}

interface HeaderRow {
  id: string;
  received_date: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  receiver_user_id: string;
  receiver_initials_snapshot: string;
  receiver_name_snapshot: string;
  account_initials: string | null;
  account_name: string;
  account_type: string;
  quantity: number;
  confirmed_at: Date;
  description: string | null;
}

const SELECT_HEADER = `
  SELECT r.id, r.received_date::text AS received_date,
         p.id AS project_id, p.project_number, p.name AS project_name, p.client,
         r.receiver_user_id, r.receiver_initials_snapshot, r.receiver_name_snapshot,
         a.official_initials AS account_initials, a.display_name AS account_name,
         a.account_type, r.quantity, r.confirmed_at, r.description
  FROM receipt r
  JOIN project p ON p.id = r.project_id
  JOIN app_user a ON a.id = r.account_user_id`;

/** Newest confirmation first; the receipt ID breaks ties so pages never overlap or skip. */
const ORDER_BY = 'ORDER BY r.confirmed_at DESC, r.id DESC';

function toItem(row: HeaderRow): ReceiptLogItem {
  return {
    id: row.id,
    receivedDate: row.received_date,
    project: {
      id: row.project_id,
      projectNumber: row.project_number,
      name: row.project_name,
      client: row.client,
    },
    receiver: {
      userId: row.receiver_user_id,
      initials: row.receiver_initials_snapshot,
      name: row.receiver_name_snapshot,
    },
    account: {
      initials: row.account_initials,
      name: row.account_name,
      sharedStation: row.account_type === 'shared_lab',
    },
    quantity: row.quantity,
    confirmedAt: row.confirmed_at.toISOString(),
  };
}

export async function queryReceiptLog(pool: Pool, query: ReceiptLogQuery): Promise<ReceiptLogPage> {
  const { where, params } = buildReceiptLogWhere(query);
  const count = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM receipt r JOIN project p ON p.id = r.project_id ${where}`,
    params,
  );
  const { rows } = await pool.query<HeaderRow>(
    `${SELECT_HEADER}
     ${where}
     ${ORDER_BY}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return {
    items: rows.map(toItem),
    total: count.rows[0]!.total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

interface UnitRow {
  id: string;
  readable_id: string;
  unit_type: ReceiptUnit['unitType'];
  status: ReceiptUnit['status'];
  received_date: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  location_id: string;
  location_code: string;
  location_name: string;
}

/** The original header and every unit it created, with the units' current values. */
export async function getReceiptDetail(
  pool: Pool,
  receiptId: string,
): Promise<ReceiptDetail | null> {
  const header = await pool.query<HeaderRow>(`${SELECT_HEADER} WHERE r.id = $1`, [receiptId]);
  const row = header.rows[0];
  if (!row) return null;
  // At most 50 units per receipt (database CHECK), so no paging.
  const units = await pool.query<UnitRow>(
    `SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date,
            p.id AS project_id, p.project_number, p.name AS project_name, p.client,
            l.id AS location_id, l.code AS location_code, l.name AS location_name
     FROM storage_unit su
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     WHERE su.receipt_id = $1
     ORDER BY su.readable_id COLLATE "C"`,
    [receiptId],
  );
  const ids = units.rows.map((unit) => unit.id);
  const holes = await loadHoleSummaries(pool, ids);
  const identities = await loadSampleIdentities(pool, ids);
  return {
    ...toItem(row),
    description: row.description,
    units: units.rows.map((unit) => ({
      id: unit.id,
      readableId: unit.readable_id,
      unitType: unit.unit_type,
      status: unit.status,
      receivedDate: unit.received_date,
      project: {
        id: unit.project_id,
        projectNumber: unit.project_number,
        name: unit.project_name,
        client: unit.client,
      },
      holes: holes.get(unit.id) ?? [],
      sample: identities.get(unit.id)?.sample ?? null,
      bulkGroup: membershipOf(identities.get(unit.id)),
      location: { id: unit.location_id, code: unit.location_code, name: unit.location_name },
    })),
  };
}

/**
 * People who received at least one receipt, matched by current or snapshot initials (prefix) or
 * name (contains). Disabled and renamed people are included so their receipts stay findable;
 * the option shows their current name.
 */
export async function listReceiptReceivers(
  pool: Pool,
  query: ReceiptReceiverQuery,
): Promise<ReceiverOption[]> {
  const text = likeEscape(query.search ?? '');
  const { rows } = await pool.query<{
    id: string;
    initials: string;
    display_name: string;
  }>(
    `WITH receivers AS (
       SELECT receiver_user_id AS id,
              (array_agg(receiver_initials_snapshot ORDER BY confirmed_at DESC))[1] AS latest_initials,
              bool_or(receiver_initials_snapshot ILIKE $1 || '%'
                      OR receiver_name_snapshot ILIKE '%' || $1 || '%') AS snapshot_match
       FROM receipt
       WHERE ($2::uuid IS NULL OR receiver_user_id = $2::uuid)
       GROUP BY receiver_user_id
     )
     SELECT u.id, coalesce(u.official_initials, r.latest_initials) AS initials, u.display_name
     FROM receivers r
     JOIN app_user u ON u.id = r.id
     WHERE $1 = '' OR r.snapshot_match
        OR u.official_initials ILIKE $1 || '%' OR u.display_name ILIKE '%' || $1 || '%'
     ORDER BY (upper(coalesce(u.official_initials, r.latest_initials)) = upper($1)) DESC,
              coalesce(u.official_initials, r.latest_initials), lower(u.display_name), u.id
     LIMIT ${RECEIPT_LOG_RECEIVER_LIMIT}`,
    [text, query.id ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    initials: row.initials,
    displayName: row.display_name,
  }));
}

@Injectable()
export class ReceivingLogService {
  constructor(private readonly database: DatabaseService) {}

  list(query: ReceiptLogQuery): Promise<ReceiptLogPage> {
    return queryReceiptLog(this.database.pool, query);
  }

  detail(receiptId: string): Promise<ReceiptDetail | null> {
    return getReceiptDetail(this.database.pool, receiptId);
  }

  receivers(query: ReceiptReceiverQuery): Promise<ReceiverOption[]> {
    return listReceiptReceivers(this.database.pool, query);
  }
}
