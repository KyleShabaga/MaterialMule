import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  LOCATION_LIST_LIMIT,
  parseScanPayload,
  type LocationDetail,
  type LocationEvent,
  type LocationLabelPreview,
  type ScanResolveResponse,
  type StorageLocation,
  type createLocationRequestSchema,
  type locationListQuerySchema,
  type retireLocationRequestSchema,
  type updateLocationRequestSchema,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { renderLocationLabelPreview } from '../labels/location-template-v1.js';
import { getLocationPrintJobs } from '../printing/print-queue.js';
import { likeEscape } from '../projects/projects.service.js';

// Storage locations administration (MM-T37). Every write locks the location row FOR UPDATE first,
// so edits, retirement and the first label request (print-queue.ts) are serialised per location:
// * a code edit can't race the first label request (the code locks inside that transaction);
// * retirement counts occupants under the lock, and storage units can only be placed in a
//   location that is active when they lock it (storage_unit_location_active trigger), so a unit can't arrive in
//   a location that is being retired, and a retirement can't miss a unit that just arrived.

export type ListQuery = z.output<typeof locationListQuerySchema>;
export type CreateInput = z.output<typeof createLocationRequestSchema>;
export type UpdateInput = z.output<typeof updateLocationRequestSchema>;
export type RetireInput = z.output<typeof retireLocationRequestSchema>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Units that occupy a location: saved there and not disposed, i.e. the Inventory "Current stock"
 * filter the blocked-retirement link opens (in stock or approved for disposal but still on the
 * shelf).
 */
const OCCUPYING = `status <> 'disposed'`;

interface LocationRow {
  id: string;
  code: string;
  name: string;
  kind: StorageLocation['kind'];
  area: string | null;
  active: boolean;
  is_system: boolean;
  retired_at: Date | null;
  retired_reason: string | null;
  code_locked_at: Date | null;
  label_printed_at: Date | null;
  in_stock_count: number;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const SELECT_LOCATION = `
  SELECT l.id, l.code_normalized AS code, l.name, l.kind, l.area, l.active, l.is_system,
         l.retired_at, l.retired_reason, l.code_locked_at, l.label_printed_at,
         (SELECT count(*)::int FROM storage_unit su
          WHERE su.current_location_id = l.id AND su.${OCCUPYING}) AS in_stock_count,
         l.created_at, l.updated_at, l.version
  FROM location l`;

function toLocation(row: LocationRow): StorageLocation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    area: row.area,
    active: row.active,
    isSystem: row.is_system,
    retiredAt: row.retired_at?.toISOString() ?? null,
    retiredReason: row.retired_reason,
    codeLocked: row.code_locked_at !== null,
    labelPrintedAt: row.label_printed_at?.toISOString() ?? null,
    inStockCount: row.in_stock_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

type Queryable = Pool | PoolClient;

export async function getLocation(db: Queryable, id: string): Promise<StorageLocation | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<LocationRow>(`${SELECT_LOCATION} WHERE l.id = $1`, [id]);
  return rows[0] ? toLocation(rows[0]) : null;
}

/**
 * Active first, then by name. Search matches code, name or area, ignoring case. At most
 * LOCATION_LIST_LIMIT rows unless `all`; `total` is the number that match (BUG-007).
 */
export async function listLocations(
  db: Queryable,
  query: ListQuery,
): Promise<{ items: StorageLocation[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!query.includeRetired) where.push('l.active');
  if (query.search) {
    params.push(`%${likeEscape(query.search.toLowerCase())}%`);
    const p = `$${params.length}`;
    where.push(
      `(lower(l.code_normalized) LIKE ${p} OR lower(l.name) LIKE ${p} OR lower(l.area) LIKE ${p})`,
    );
  }
  const { rows } = await db.query<LocationRow & { total: number }>(
    `${SELECT_LOCATION.replace('SELECT l.id,', 'SELECT count(*) OVER ()::int AS total, l.id,')}
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.active DESC, lower(l.name), l.code_normalized
     ${query.all ? '' : `LIMIT ${LOCATION_LIST_LIMIT}`}`,
    params,
  );
  return { items: rows.map(toLocation), total: rows[0]?.total ?? 0 };
}

function duplicateCode(code: string): ConflictException {
  return new ConflictException({
    code: 'location_code_exists',
    message: `A location with code ${code} already exists.`,
    field: 'code',
  });
}

function isUniqueCodeViolation(error: unknown): boolean {
  return (error as { constraint?: string }).constraint === 'location_code_key';
}

/** Locks the row, or 404. */
async function lockLocation(client: PoolClient, id: string) {
  if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'location_not_found' });
  const { rows } = await client.query<{
    id: string;
    code_normalized: string;
    name: string;
    kind: StorageLocation['kind'];
    area: string | null;
    active: boolean;
    is_system: boolean;
    code_locked_at: Date | null;
    version: number;
  }>(
    `SELECT id, code_normalized, name, kind, area, active, is_system, code_locked_at, version
     FROM location WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundException({ code: 'location_not_found' });
  return row;
}

async function versionConflict(client: PoolClient, id: string): Promise<ConflictException> {
  return new ConflictException({
    code: 'version_conflict',
    message: 'Someone else changed this location. Review the current details and try again.',
    current: (await getLocation(client, id))!,
  });
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  action: string;
  actor_initials_snapshot: string | null;
  actor_name_snapshot: string | null;
  receiver_initials_snapshot: string | null;
  receiver_name_snapshot: string | null;
  receiver_user_id: string | null;
  reason: string | null;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
}

/** The location's own events, newest first. Snapshots: names as they were at the time. */
async function locationEvents(db: Queryable, id: string): Promise<LocationEvent[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, occurred_at, action, actor_initials_snapshot, actor_name_snapshot,
            receiver_user_id, receiver_initials_snapshot, receiver_name_snapshot, reason,
            before_values, after_values
     FROM audit_event
     WHERE entity_type = 'location' AND entity_id = $1
     ORDER BY occurred_at DESC, id DESC
     LIMIT 200`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    action: row.action,
    actor: { initials: row.actor_initials_snapshot, name: row.actor_name_snapshot },
    receiver: row.receiver_user_id
      ? { initials: row.receiver_initials_snapshot, name: row.receiver_name_snapshot }
      : null,
    reason: row.reason,
    before: row.before_values,
    after: row.after_values,
  }));
}

@Injectable()
export class LocationsService {
  constructor(private readonly database: DatabaseService) {}

  list(query: ListQuery): Promise<{ items: StorageLocation[]; total: number }> {
    return listLocations(this.database.pool, query);
  }

  async detail(id: string): Promise<LocationDetail> {
    const location = await getLocation(this.database.pool, id);
    if (!location) throw new NotFoundException({ code: 'location_not_found' });
    const [events, printJobs] = await Promise.all([
      locationEvents(this.database.pool, id),
      getLocationPrintJobs(this.database.pool, id),
    ]);
    return { location, events, printJobs };
  }

  /** The label as the ZD621 would print it now. Read-only: no job, no audit, no code lock. */
  async labelPreview(id: string): Promise<LocationLabelPreview> {
    const location = await getLocation(this.database.pool, id);
    if (!location) throw new NotFoundException({ code: 'location_not_found' });
    const preview = renderLocationLabelPreview({ code: location.code, name: location.name });
    return { locationId: location.id, ...preview };
  }

  async create(
    input: CreateInput,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<StorageLocation> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO location (code, name, kind, area) VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.code, input.name, input.kind, input.area],
        );
        const id = rows[0]!.id;
        await recordAudit(client, {
          action: 'location.created',
          entityType: 'location',
          entityId: id,
          actor,
          after: { code: input.code, name: input.name, kind: input.kind, area: input.area },
          requestId,
        });
        return (await getLocation(client, id))!;
      });
    } catch (error) {
      if (isUniqueCodeViolation(error)) throw duplicateCode(input.code);
      throw error;
    }
  }

  /**
   * Edits name, kind, area and (until the first label request) code. Only changed fields are
   * written and audited; a save that changes nothing returns the location untouched.
   */
  async update(
    id: string,
    input: UpdateInput,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<StorageLocation> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const row = await lockLocation(client, id);
        if (input.version !== row.version) throw await versionConflict(client, id);
        if (!row.active) {
          throw new UnprocessableEntityException({
            code: 'location_retired',
            message: 'This location is retired and can no longer be edited.',
          });
        }
        const before = {
          code: row.code_normalized,
          name: row.name,
          kind: row.kind,
          area: row.area,
        };
        const requested: Partial<typeof before> = {
          code: input.code,
          name: input.name,
          kind: input.kind,
          area: input.area,
        };
        const changed = (Object.keys(before) as (keyof typeof before)[]).filter(
          (key) => requested[key] !== undefined && requested[key] !== before[key],
        );
        if (changed.length === 0) return (await getLocation(client, id))!;

        if (row.is_system && changed.some((key) => key !== 'name')) {
          throw new UnprocessableEntityException({
            code: 'system_location',
            message: 'Receiving lab is a system location: only its display name can change.',
          });
        }
        if (changed.includes('code') && row.code_locked_at !== null) {
          throw new UnprocessableEntityException({
            code: 'location_code_locked',
            message:
              'This code is already on a printed or queued label, so it can no longer change. ' +
              'You can still rename the location.',
            field: 'code',
          });
        }

        const columns = { code: 'code', name: 'name', kind: 'kind', area: 'area' } as const;
        const params: unknown[] = [id];
        const assignments = changed.map((key) => {
          params.push(requested[key]);
          return `${columns[key]} = $${params.length}`;
        });
        await client.query(
          `UPDATE location SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
           WHERE id = $1`,
          params,
        );
        await recordAudit(client, {
          action: 'location.updated',
          entityType: 'location',
          entityId: id,
          actor,
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, requested[key]])),
          requestId,
        });
        return (await getLocation(client, id))!;
      });
    } catch (error) {
      if (input.code !== undefined && isUniqueCodeViolation(error)) {
        throw duplicateCode(input.code);
      }
      throw error;
    }
  }

  /**
   * Retires a location: it stays on every historical record but can't receive units. Receiving
   * lab never retires (422); a location that still holds units can't retire (409 with the count).
   * The count is taken under the row lock, so a unit moving in concurrently is either counted or
   * refused by the database.
   */
  async retire(
    id: string,
    input: RetireInput,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<StorageLocation> {
    return withTransaction(this.database.pool, async (client) => {
      const row = await lockLocation(client, id);
      if (row.is_system) {
        throw new UnprocessableEntityException({
          code: 'system_location',
          message: 'Receiving lab is a system location and can’t be retired.',
        });
      }
      if (input.version !== row.version) throw await versionConflict(client, id);
      if (!row.active) {
        throw new ConflictException({
          code: 'location_retired',
          message: 'This location is already retired.',
        });
      }
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM storage_unit
         WHERE current_location_id = $1 AND ${OCCUPYING}`,
        [id],
      );
      const inStockCount = rows[0]!.count;
      if (inStockCount > 0) {
        throw new ConflictException({
          code: 'location_occupied',
          message:
            inStockCount === 1
              ? '1 storage unit is still at this location. Move it before retiring the location.'
              : `${inStockCount} storage units are still at this location. Move them before retiring the location.`,
          inStockCount,
        });
      }
      await client.query(
        `UPDATE location
         SET active = false, retired_at = now(), retired_reason = $2,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, input.reason],
      );
      await recordAudit(client, {
        action: 'location.retired',
        entityType: 'location',
        entityId: id,
        actor,
        reason: input.reason,
        before: { active: true },
        after: { active: false, code: row.code_normalized, name: row.name },
        requestId,
      });
      return (await getLocation(client, id))!;
    });
  }

  /**
   * What a scanned label is (MM-T37, for T28): a location label (LOC-<CODE>) or a storage unit
   * sticker (PREFIX-YYYY-NNNNNN). A retired location still resolves (marked inactive) so the
   * scanner can say why it can't be used; it is never offered as a destination.
   */
  async resolveScan(payload: string): Promise<ScanResolveResponse> {
    const parsed = parseScanPayload(payload);
    const pool = this.database.pool;
    if (parsed.type === 'location') {
      const { rows } = await pool.query<{
        id: string;
        code: string;
        name: string;
        kind: StorageLocation['kind'];
        area: string | null;
        active: boolean;
      }>(
        `SELECT id, code_normalized AS code, name, kind, area, active
         FROM location WHERE code_normalized = $1`,
        [parsed.code],
      );
      const location = rows[0];
      return location
        ? { type: 'location', location }
        : { type: 'unknown', reason: 'location_not_found' };
    }
    if (parsed.type === 'storage_unit') {
      const { rows } = await pool.query<{ id: string; readable_id: string }>(
        'SELECT id, readable_id FROM storage_unit WHERE readable_id = $1',
        [parsed.readableId],
      );
      const unit = rows[0];
      return unit
        ? { type: 'storage_unit', storageUnit: { id: unit.id, readableId: unit.readable_id } }
        : { type: 'unknown', reason: 'storage_unit_not_found' };
    }
    return { type: 'unknown', reason: 'not_recognised' };
  }
}
