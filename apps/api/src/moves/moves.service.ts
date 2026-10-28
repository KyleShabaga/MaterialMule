import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  LocationConflictDetail,
  MoveConflictResponse,
  MoveRequest,
  MoveSavedResponse,
  MovementEvent,
  resolveLocationConflictRequestSchema,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor, type AuditReceiver } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { canonicalJson } from '../receiving/payload-hash.js';
import { auditReceiver, findActiveStaff } from '../staff-directory/staff-directory.js';

// Storage moves and location conflicts (MM-T28). One transaction per request, READ COMMITTED.
//
// Lock order (docs/database.md "Storage moves"): the storage unit FOR UPDATE, then the destination
// location FOR KEY SHARE, then the unit's open location conflict FOR UPDATE. Corrections (T13) and
// bulk-group changes (T36) lock the unit first as well; location retirement (T37) locks only the
// location FOR UPDATE and counts occupants, so a move and a retirement serialise on the location
// row whichever starts first: the move then sees the retirement (422) or the retirement counts the
// unit (409). Two deliveries of one clientMoveId serialise on the unit lock and the second replays
// the first's recorded outcome; two different actions on one unit serialise on the same lock and
// the second sees the first's new version, so it becomes a contested attempt (never last-clock-
// wins, never a silent rebase onto the newer version).

export type ResolveInput = z.output<typeof resolveLocationConflictRequestSchema>;

export type MoveResult =
  { status: 200 | 201; body: MoveSavedResponse } | { status: 409; body: MoveConflictResponse };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONFLICT_MESSAGE =
  'This storage unit changed after the scan, so the move was not applied. ' +
  'A person must check where it actually is and confirm the location.';

/** SHA-256 of the validated intent without its ID: what a retry must repeat exactly. */
export function moveRequestHash(request: MoveRequest): string {
  const { clientMoveId: _id, ...intent } = request;
  return createHash('sha256').update(canonicalJson(intent), 'utf8').digest('hex');
}

function resolutionHash(input: ResolveInput, conflictId: string): string {
  const { clientResolutionId: _id, ...intent } = input;
  return createHash('sha256')
    .update(canonicalJson({ conflictId, ...intent }), 'utf8')
    .digest('hex');
}

function keyReused(): ConflictException {
  return new ConflictException({
    code: 'idempotency_key_reused',
    message: 'This move ID was already used for a different move.',
  });
}

function actorFor(user: AuthUser): AuditActor {
  return {
    userId: user.userId,
    accountType: user.accountType,
    initials: user.initials,
    name: user.displayName,
  };
}

interface ActionRow {
  client_move_id: string;
  account_user_id: string;
  storage_unit_id: string;
  station_id: string;
  request_hash: string;
  outcome: 'saved' | 'conflict';
  movement_event_id: string;
  conflict_id: string | null;
  resulting_version: number;
  applied_to_location_id: string | null;
  saved_at: Date;
}

async function findAction(client: PoolClient, id: string): Promise<ActionRow | null> {
  const { rows } = await client.query<ActionRow>(
    'SELECT * FROM move_action WHERE client_move_id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** The recorded outcome of an action, as the first delivery answered (but marked replayed). */
function replayOf(action: ActionRow, replayed: boolean): MoveResult {
  if (action.outcome === 'saved') {
    return {
      status: replayed ? 200 : 201,
      body: {
        outcome: 'saved',
        clientMoveId: action.client_move_id,
        movementEventId: action.movement_event_id,
        appliedToLocationId: action.applied_to_location_id!,
        resultingVersion: action.resulting_version,
        savedAt: action.saved_at.toISOString(),
        replayed,
      },
    };
  }
  return {
    status: 409,
    body: {
      code: 'location_conflict',
      outcome: 'conflict',
      message: CONFLICT_MESSAGE,
      clientMoveId: action.client_move_id,
      attemptEventId: action.movement_event_id,
      conflictId: action.conflict_id!,
      currentVersion: action.resulting_version,
      replayed,
    },
  };
}

interface LockedUnit {
  id: string;
  readable_id: string;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  version: number;
  current_location_id: string;
}

async function lockUnit(client: PoolClient, id: string): Promise<LockedUnit> {
  const { rows } = await client.query<LockedUnit>(
    `SELECT id, readable_id, status, version, current_location_id
     FROM storage_unit WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) {
    throw new NotFoundException({
      code: 'storage_unit_not_found',
      message: 'That storage unit was not found.',
    });
  }
  return rows[0];
}

interface LocationRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

async function locationById(client: PoolClient, id: string): Promise<LocationRow | null> {
  const { rows } = await client.query<LocationRow>(
    'SELECT id, code_normalized AS code, name, active FROM location WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Locks the destination against a concurrent retirement and checks it can receive units. */
async function lockDestination(client: PoolClient, id: string): Promise<LocationRow> {
  const { rows } = await client.query<LocationRow>(
    `SELECT id, code_normalized AS code, name, active FROM location WHERE id = $1 FOR KEY SHARE`,
    [id],
  );
  const location = rows[0];
  if (!location) {
    throw new NotFoundException({
      code: 'location_not_found',
      message: 'That location was not found.',
    });
  }
  if (!location.active) {
    throw new UnprocessableEntityException({
      code: 'location_retired',
      message: `${location.name} is retired and can’t receive storage units. Scan another destination.`,
    });
  }
  return location;
}

function refuseDisposed(unit: LockedUnit): void {
  if (unit.status === 'disposed') {
    throw new UnprocessableEntityException({
      code: 'storage_unit_disposed',
      message: `${unit.readable_id} is disposed and can’t be moved.`,
    });
  }
}

/** Staff member credited at a LAB station; personal accounts are credited themselves. */
async function resolveMover(
  client: PoolClient,
  user: AuthUser,
  moverUserId: string | undefined,
): Promise<AuditReceiver | null> {
  if (user.accountType !== 'shared_lab') {
    if (moverUserId !== undefined && moverUserId !== user.userId) {
      throw new UnprocessableEntityException({
        code: 'mover_not_allowed',
        message: 'Only a shared LAB station names who moved the unit.',
      });
    }
    return null;
  }
  if (!moverUserId) {
    throw new UnprocessableEntityException({
      code: 'mover_required',
      message: 'Choose who is moving these storage units.',
    });
  }
  const staff = await findActiveStaff(client, moverUserId);
  if (!staff) {
    throw new UnprocessableEntityException({
      code: 'unknown_mover',
      message: 'The person chosen as "Moved by" is not an active staff member.',
    });
  }
  return auditReceiver(staff);
}

/** Short station label for display: enough to tell two LAB computers apart, nothing more. */
function stationLabel(stationId: string | null): string | null {
  return stationId ? stationId.slice(0, 8).toUpperCase() : null;
}

interface EventRow {
  id: string;
  kind: MovementEvent['kind'];
  from_id: string;
  from_code: string;
  from_name: string;
  to_id: string;
  to_code: string;
  to_name: string;
  base_version: number | null;
  resulting_version: number | null;
  actor_account_type: MovementEvent['actor']['accountType'];
  actor_initials_snapshot: string | null;
  actor_name_snapshot: string;
  mover_initials_snapshot: string | null;
  mover_name_snapshot: string | null;
  scanned_at: Date | null;
  saved_at: Date;
  source: MovementEvent['source'];
  station_id: string | null;
  note: string | null;
}

const SELECT_EVENT = `
  SELECT e.id, e.kind,
         f.id AS from_id, f.code_normalized AS from_code, f.name AS from_name,
         t.id AS to_id, t.code_normalized AS to_code, t.name AS to_name,
         e.base_version, e.resulting_version, e.actor_account_type, e.actor_initials_snapshot,
         e.actor_name_snapshot, e.mover_initials_snapshot, e.mover_name_snapshot, e.scanned_at,
         e.saved_at, e.source, e.station_id, e.note
  FROM movement_event e
  JOIN location f ON f.id = e.from_location_id
  JOIN location t ON t.id = e.to_location_id`;

function toEvent(row: EventRow): MovementEvent {
  return {
    id: row.id,
    kind: row.kind,
    from: { id: row.from_id, code: row.from_code, name: row.from_name },
    to: { id: row.to_id, code: row.to_code, name: row.to_name },
    baseVersion: row.base_version,
    resultingVersion: row.resulting_version,
    actor: {
      initials: row.actor_initials_snapshot,
      name: row.actor_name_snapshot,
      accountType: row.actor_account_type,
    },
    mover:
      row.mover_name_snapshot === null
        ? null
        : { initials: row.mover_initials_snapshot, name: row.mover_name_snapshot },
    scannedAt: row.scanned_at?.toISOString() ?? null,
    savedAt: row.saved_at.toISOString(),
    source: row.source,
    station: stationLabel(row.station_id),
    note: row.note,
  };
}

interface ConflictRow {
  id: string;
  status: 'open' | 'resolved';
  version: number;
  opened_at: Date;
  storage_unit_id: string;
  saved_version: number;
  readable_id: string;
  unit_status: LocationConflictDetail['storageUnit']['status'];
  unit_version: number;
  location_id: string;
  location_code: string;
  location_name: string;
  resolved_at: Date | null;
  resolved_by_initials_snapshot: string | null;
  resolved_by_name_snapshot: string | null;
  resolved_location_id: string | null;
  resolved_code: string | null;
  resolved_name: string | null;
  resolution_note: string | null;
}

/** A conflict with both sides of the story; read inside a transaction or from the pool. */
export async function getLocationConflict(
  db: Pool | PoolClient,
  id: string,
): Promise<LocationConflictDetail | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ConflictRow>(
    `SELECT c.id, c.status, c.version, c.opened_at, c.storage_unit_id, c.saved_version,
            su.readable_id, su.status AS unit_status, su.version AS unit_version,
            l.id AS location_id, l.code_normalized AS location_code, l.name AS location_name,
            c.resolved_at, c.resolved_by_initials_snapshot, c.resolved_by_name_snapshot,
            c.resolved_location_id, rl.code_normalized AS resolved_code, rl.name AS resolved_name,
            c.resolution_note
     FROM location_conflict c
     JOIN storage_unit su ON su.id = c.storage_unit_id
     JOIN location l ON l.id = su.current_location_id
     LEFT JOIN location rl ON rl.id = c.resolved_location_id
     WHERE c.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const events = await db.query<EventRow>(
    `${SELECT_EVENT} WHERE e.conflict_id = $1 ORDER BY e.saved_at, e.kind = 'resolution', e.id`,
    [id],
  );
  // The saved move the contested scans compete with: the one that produced the version the
  // conflict opened on. None when a correction or receipt produced it instead.
  const saved = await db.query<EventRow>(
    `${SELECT_EVENT}
     WHERE e.storage_unit_id = $1 AND e.kind IN ('move', 'resolution') AND e.resulting_version = $2
     ORDER BY e.saved_at DESC LIMIT 1`,
    [row.storage_unit_id, row.saved_version],
  );
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    openedAt: row.opened_at.toISOString(),
    storageUnit: {
      id: row.storage_unit_id,
      readableId: row.readable_id,
      status: row.unit_status,
      savedLocation: { id: row.location_id, code: row.location_code, name: row.location_name },
      version: row.unit_version,
    },
    savedEvent: saved.rows[0] ? toEvent(saved.rows[0]) : null,
    events: events.rows.map(toEvent),
    resolution: row.resolved_at
      ? {
          resolvedAt: row.resolved_at.toISOString(),
          resolvedBy: {
            initials: row.resolved_by_initials_snapshot,
            name: row.resolved_by_name_snapshot!,
          },
          location: {
            id: row.resolved_location_id!,
            code: row.resolved_code!,
            name: row.resolved_name!,
          },
          note: row.resolution_note,
        }
      : null,
  };
}

/** The unit's open conflict, for storage unit detail. */
export async function openConflictSummary(
  db: Pool | PoolClient,
  storageUnitId: string,
): Promise<{ id: string; version: number; openedAt: string } | null> {
  const { rows } = await db.query<{ id: string; version: number; opened_at: Date }>(
    `SELECT id, version, opened_at FROM location_conflict
     WHERE storage_unit_id = $1 AND status = 'open'`,
    [storageUnitId],
  );
  const row = rows[0];
  return row ? { id: row.id, version: row.version, openedAt: row.opened_at.toISOString() } : null;
}

@Injectable()
export class MovesService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Records one move intent. Saved → 201 (200 on replay); unit changed since the scan, or a
   * conflict already open → 409 `location_conflict`, committed with its attempt event so a retry
   * returns the same IDs. Every other refusal rolls back and records nothing.
   */
  async move(request: MoveRequest, user: AuthUser, requestId: string | null): Promise<MoveResult> {
    // The queue belongs to the account that scanned: never replayed under another account.
    if (request.captureContext.accountId !== user.userId) {
      throw new ForbiddenException({
        code: 'capture_account_mismatch',
        message:
          'These moves were scanned by another account. Sign in as that account to send them.',
      });
    }
    const hash = moveRequestHash(request);
    return withTransaction(this.database.pool, async (client) => {
      const replay = async () => {
        const existing = await findAction(client, request.clientMoveId);
        if (!existing) return null;
        // Another account can't adopt an action or learn its outcome.
        if (existing.account_user_id !== user.userId || existing.request_hash !== hash) {
          throw keyReused();
        }
        return replayOf(existing, true);
      };
      const early = await replay();
      if (early) return early;

      const unit = await lockUnit(client, request.storageUnitId);
      // A concurrent delivery of the same ID may have committed while this one waited.
      const late = await replay();
      if (late) return late;

      refuseDisposed(unit);
      const destination = await lockDestination(client, request.toLocationId);
      const mover = await resolveMover(client, user, request.captureContext.moverUserId);
      const expectedVersion = await this.expectedVersion(client, request, user);

      const { rows: open } = await client.query<{ id: string; version: number }>(
        `SELECT id, version FROM location_conflict
         WHERE storage_unit_id = $1 AND status = 'open' FOR UPDATE`,
        [unit.id],
      );
      const from = (await locationById(client, unit.current_location_id))!;
      const actor = actorFor(user);
      const source = request.capturedOffline ? 'queued' : 'online';
      const common = {
        clientMoveId: request.clientMoveId,
        scannedAt: request.scannedAt,
        source,
        station: stationLabel(request.captureContext.stationId),
      };

      if (open[0] || unit.version !== expectedVersion) {
        // Contested: keep both stories and let a person decide. Nothing about the unit changes.
        let conflictId: string;
        if (open[0]) {
          conflictId = open[0].id;
          await client.query('UPDATE location_conflict SET version = version + 1 WHERE id = $1', [
            conflictId,
          ]);
        } else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
             VALUES ($1, $2, $3) RETURNING id`,
            [unit.id, unit.current_location_id, unit.version],
          );
          conflictId = rows[0]!.id;
        }
        const eventId = await this.insertEvent(client, {
          kind: 'contested',
          unitId: unit.id,
          from: unit.current_location_id,
          to: destination.id,
          baseVersion: request.baseVersion,
          resultingVersion: null,
          user,
          mover,
          request,
          source,
          conflictId,
        });
        const action = await this.insertAction(client, request, user, hash, {
          outcome: 'conflict',
          eventId,
          conflictId,
          resultingVersion: unit.version,
          appliedTo: null,
        });
        await recordAudit(client, {
          action: 'storage_unit.location_conflict',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor,
          receiver: mover,
          before: { location: { code: from.code, name: from.name }, version: unit.version },
          after: {
            ...common,
            conflictId,
            attemptedLocation: { code: destination.code, name: destination.name },
            baseVersion: request.baseVersion,
            expectedVersion,
          },
          requestId,
        });
        return replayOf(action, false);
      }

      // Saved. A scan at the unit's own saved location confirms it there without a new version,
      // so it can't make other stations' pending moves conflict for nothing.
      const stays = destination.id === unit.current_location_id;
      const resultingVersion = stays ? unit.version : unit.version + 1;
      if (!stays) {
        await client.query(
          `UPDATE storage_unit
           SET current_location_id = $2, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [unit.id, destination.id],
        );
      }
      const eventId = await this.insertEvent(client, {
        kind: 'move',
        unitId: unit.id,
        from: unit.current_location_id,
        to: destination.id,
        baseVersion: request.baseVersion,
        resultingVersion,
        user,
        mover,
        request,
        source,
        conflictId: null,
      });
      const action = await this.insertAction(client, request, user, hash, {
        outcome: 'saved',
        eventId,
        conflictId: null,
        resultingVersion,
        appliedTo: destination.id,
      });
      await recordAudit(client, {
        action: 'storage_unit.moved',
        entityType: 'storage_unit',
        entityId: unit.id,
        actor,
        receiver: mover,
        before: { location: { code: from.code, name: from.name } },
        after: {
          ...common,
          location: { code: destination.code, name: destination.name },
          ...(stays ? { confirmedInPlace: true } : {}),
        },
        requestId,
      });
      return replayOf(action, false);
    });
  }

  /**
   * The version the unit must still have for this move to apply: its base version, or, for the
   * next move in a chain queued at one station, what the previous move left it at. The previous
   * move must be this account's and station's, for the same unit, and already saved.
   */
  private async expectedVersion(
    client: PoolClient,
    request: MoveRequest,
    user: AuthUser,
  ): Promise<number> {
    if (!request.previousClientMoveId) return request.baseVersion;
    const previous = await findAction(client, request.previousClientMoveId);
    if (!previous) {
      throw new ConflictException({
        code: 'predecessor_not_applied',
        message: 'The earlier move of this unit hasn’t been saved yet.',
      });
    }
    if (
      previous.account_user_id !== user.userId ||
      previous.station_id !== request.captureContext.stationId ||
      previous.storage_unit_id !== request.storageUnitId
    ) {
      throw new UnprocessableEntityException({
        code: 'predecessor_invalid',
        message: 'The earlier move named here belongs to another unit, station or account.',
      });
    }
    if (previous.outcome !== 'saved') {
      throw new ConflictException({
        code: 'predecessor_not_applied',
        message:
          'The earlier move of this unit is in a location conflict, so this one waits until a ' +
          'person confirms where the unit is.',
      });
    }
    return previous.resulting_version;
  }

  private async insertEvent(
    client: PoolClient,
    event: {
      kind: 'move' | 'contested';
      unitId: string;
      from: string;
      to: string;
      baseVersion: number;
      resultingVersion: number | null;
      user: AuthUser;
      mover: AuditReceiver | null;
      request: MoveRequest;
      source: 'online' | 'queued';
      conflictId: string | null;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO movement_event (storage_unit_id, kind, from_location_id, to_location_id,
                                   base_version, resulting_version, actor_user_id,
                                   actor_account_type, actor_initials_snapshot, actor_name_snapshot,
                                   mover_user_id, mover_initials_snapshot, mover_name_snapshot,
                                   station_id, scanned_at, source, client_move_id, conflict_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [
        event.unitId,
        event.kind,
        event.from,
        event.to,
        event.baseVersion,
        event.resultingVersion,
        event.user.userId,
        event.user.accountType,
        event.user.initials,
        event.user.displayName,
        event.mover?.userId ?? null,
        event.mover?.initials ?? null,
        event.mover?.name ?? null,
        event.request.captureContext.stationId,
        event.request.scannedAt,
        event.source,
        event.request.clientMoveId,
        event.conflictId,
      ],
    );
    return rows[0]!.id;
  }

  private async insertAction(
    client: PoolClient,
    request: MoveRequest,
    user: AuthUser,
    hash: string,
    outcome: {
      outcome: 'saved' | 'conflict';
      eventId: string;
      conflictId: string | null;
      resultingVersion: number;
      appliedTo: string | null;
    },
  ): Promise<ActionRow> {
    const { rows } = await client.query<ActionRow>(
      `INSERT INTO move_action (client_move_id, account_user_id, storage_unit_id, station_id,
                                previous_client_move_id, request_hash, outcome, movement_event_id,
                                conflict_id, resulting_version, applied_to_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (client_move_id) DO NOTHING
       RETURNING *`,
      [
        request.clientMoveId,
        user.userId,
        request.storageUnitId,
        request.captureContext.stationId,
        request.previousClientMoveId ?? null,
        hash,
        outcome.outcome,
        outcome.eventId,
        outcome.conflictId,
        outcome.resultingVersion,
        outcome.appliedTo,
      ],
    );
    // Same ID committed meanwhile for another unit (same unit would have waited on its lock):
    // a reused key. Throwing rolls this attempt back.
    if (!rows[0]) throw keyReused();
    return rows[0];
  }

  async conflict(id: string): Promise<LocationConflictDetail> {
    const conflict = await getLocationConflict(this.database.pool, id);
    if (!conflict) {
      throw new NotFoundException({ code: 'location_conflict_not_found' });
    }
    return conflict;
  }

  /**
   * A personal account confirms where the unit actually is (D29). Both stories stay in history;
   * the saved location becomes the confirmed one and the unit's version goes up, so any scan
   * still queued from before the conflict is contested rather than applied on top.
   */
  async resolve(
    conflictId: string,
    input: ResolveInput,
    user: AuthUser,
    requestId: string | null,
  ): Promise<{ conflict: LocationConflictDetail; replayed: boolean }> {
    const hash = resolutionHash(input, conflictId);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const current = async () => (await getLocationConflict(client, conflictId))!;
        if (!UUID_PATTERN.test(conflictId)) {
          throw new NotFoundException({ code: 'location_conflict_not_found' });
        }
        const { rows: found } = await client.query<{ storage_unit_id: string }>(
          'SELECT storage_unit_id FROM location_conflict WHERE id = $1',
          [conflictId],
        );
        if (!found[0]) throw new NotFoundException({ code: 'location_conflict_not_found' });
        const unit = await lockUnit(client, found[0].storage_unit_id);
        const { rows } = await client.query<{
          status: 'open' | 'resolved';
          version: number;
          client_resolution_id: string | null;
          resolution_request_hash: string | null;
          resolved_by_user_id: string | null;
        }>(
          `SELECT status, version, client_resolution_id, resolution_request_hash,
                  resolved_by_user_id
           FROM location_conflict WHERE id = $1 FOR UPDATE`,
          [conflictId],
        );
        const conflict = rows[0]!;
        if (conflict.client_resolution_id === input.clientResolutionId) {
          if (
            conflict.resolution_request_hash !== hash ||
            conflict.resolved_by_user_id !== user.userId
          ) {
            throw keyReused();
          }
          return { conflict: await current(), replayed: true };
        }
        if (conflict.status === 'resolved') {
          throw new ConflictException({
            code: 'conflict_already_resolved',
            message: 'Someone already confirmed this unit’s location.',
            current: await current(),
          });
        }
        if (
          conflict.version !== input.expectedConflictVersion ||
          unit.version !== input.expectedUnitVersion
        ) {
          throw new ConflictException({
            code: 'conflict_version_changed',
            message:
              'Something changed while you were checking. Review the latest and confirm again.',
            current: await current(),
          });
        }
        refuseDisposed(unit);
        const destination = await lockDestination(client, input.locationId);
        const from = (await locationById(client, unit.current_location_id))!;
        const resultingVersion = unit.version + 1;
        await client.query(
          `UPDATE storage_unit
           SET current_location_id = $2, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [unit.id, destination.id],
        );
        await client.query(
          `INSERT INTO movement_event (storage_unit_id, kind, from_location_id, to_location_id,
                                       base_version, resulting_version, actor_user_id,
                                       actor_account_type, actor_initials_snapshot,
                                       actor_name_snapshot, source, conflict_id, note)
           VALUES ($1, 'resolution', $2, $3, $4, $5, $6, $7, $8, $9, 'resolution', $10, $11)`,
          [
            unit.id,
            unit.current_location_id,
            destination.id,
            unit.version,
            resultingVersion,
            user.userId,
            user.accountType,
            user.initials,
            user.displayName,
            conflictId,
            input.note,
          ],
        );
        await client.query(
          `UPDATE location_conflict
           SET status = 'resolved', version = version + 1, resolved_at = now(),
               resolved_by_user_id = $2, resolved_by_initials_snapshot = $3,
               resolved_by_name_snapshot = $4, resolved_location_id = $5, resolution_note = $6,
               client_resolution_id = $7, resolution_request_hash = $8
           WHERE id = $1`,
          [
            conflictId,
            user.userId,
            user.initials,
            user.displayName,
            destination.id,
            input.note,
            input.clientResolutionId,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'storage_unit.location_conflict_resolved',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor: actorFor(user),
          reason: input.note,
          before: { location: { code: from.code, name: from.name } },
          after: {
            conflictId,
            location: { code: destination.code, name: destination.name },
          },
          requestId,
        });
        return { conflict: await current(), replayed: false };
      });
    } catch (error) {
      // The same resolution ID already settled a different conflict.
      if (
        (error as { constraint?: string }).constraint ===
        'location_conflict_client_resolution_id_key'
      ) {
        throw keyReused();
      }
      throw error;
    }
  }
}
