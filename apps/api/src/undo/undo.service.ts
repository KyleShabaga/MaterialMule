import { ConflictException, Injectable } from '@nestjs/common';
import {
  UNDO_BLOCKED_MESSAGES,
  UNDO_MOVE_WINDOW_MINUTES,
  UNDO_OF_MOVEMENT_EVENT_KEY,
  type UndoAction,
  type UndoBlockedReason,
  type UndoEligibility,
  type UndoRequest,
  type UndoResult,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { can, type AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { MovesService } from '../moves/moves.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { BusinessClock } from '../retention/business-clock.js';
import { findActiveStaff } from '../staff-directory/staff-directory.js';

// STRATA-123: audited Undo. A move is undone by a NEW move back to where the original found the
// unit, saved through MovesService (same rules, locks, audit) and linked to the original in
// movement_reversal (migration 0041). Nothing is deleted or rolled back, and the browser never
// supplies the previous values: the server reads them from the original event. Every guard is
// checked again at execution inside the transaction, after the unit's lock (the same lock order
// as a move: storage_unit FOR UPDATE, then the location FOR KEY SHARE, then the open conflict).
// Undo of an undo is not allowed: the person makes a new move instead.

const WINDOW_MS = UNDO_MOVE_WINDOW_MINUTES * 60_000;

export class UndoBlocked extends ConflictException {
  constructor(readonly reason: UndoBlockedReason) {
    super({
      code: 'undo_blocked',
      blockedReason: reason,
      message: UNDO_BLOCKED_MESSAGES[reason],
    });
  }
}

interface OriginalMove {
  id: string;
  storage_unit_id: string;
  from_location_id: string;
  to_location_id: string;
  resulting_version: number;
  actor_user_id: string;
  mover_user_id: string | null;
  station_id: string;
  saved_at: Date;
  is_reversal: boolean;
}

interface ReversalRow {
  original_event_id: string;
  reversal_event_id: string;
  account_user_id: string;
  storage_unit_id: string;
  to_location_id: string;
  to_code: string;
  resulting_version: number;
  saved_at: Date;
}

const SELECT_REVERSAL = `
  SELECT r.original_event_id, r.reversal_event_id, r.account_user_id, e.storage_unit_id,
         e.to_location_id, l.code_normalized AS to_code, e.resulting_version, e.saved_at
  FROM movement_reversal r
  JOIN movement_event e ON e.id = r.reversal_event_id
  JOIN location l ON l.id = e.to_location_id`;

/** "Put the holder back on SH-A-01 too." The record moved; the holder must follow. */
export function physicalReminder(locationCode: string): string {
  return `Put the holder back on ${locationCode} too.`;
}

function resultOf(row: ReversalRow, replayed: boolean): UndoResult {
  return {
    action: 'move',
    sourceId: row.original_event_id,
    reversalEventId: row.reversal_event_id,
    undoneAt: row.saved_at.toISOString(),
    replayed,
    storageUnit: {
      id: row.storage_unit_id,
      locationId: row.to_location_id,
      version: row.resulting_version,
    },
    physicalReminder: physicalReminder(row.to_code),
  };
}

function keyReused(): ConflictException {
  return new ConflictException({
    code: 'idempotency_key_reused',
    message: 'This undo ID was already used for something else.',
  });
}

@Injectable()
export class UndoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly moves: MovesService,
    private readonly notifications: NotificationsService,
    private readonly clock: BusinessClock,
  ) {}

  async eligibility(
    user: AuthUser,
    action: UndoAction,
    sourceId: string,
    moverUserId: string | undefined,
  ): Promise<UndoEligibility> {
    const answer = (reason: UndoBlockedReason | null, availableUntil: Date | null = null) => ({
      action,
      sourceId,
      eligible: reason === null,
      blockedReason: reason,
      availableUntil: availableUntil?.toISOString() ?? null,
    });
    if (action === 'notification_dismiss') {
      return answer(await this.notificationBlock(this.database.pool, user, sourceId));
    }
    const original = await this.ownOriginal(this.database.pool, user, sourceId, moverUserId);
    if (!original) return answer('not_found');
    const until = new Date(original.saved_at.getTime() + WINDOW_MS);
    const reason = await this.moveBlock(this.database.pool, user, original, false);
    return answer(reason, until);
  }

  async undo(user: AuthUser, input: UndoRequest, requestId: string | null): Promise<UndoResult> {
    if (input.action === 'notification_dismiss') return this.undoDismiss(user, input.sourceId);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const replay = async () => {
          const { rows } = await client.query<ReversalRow>(
            `${SELECT_REVERSAL} WHERE r.idempotency_key = $1`,
            [input.idempotencyKey],
          );
          const row = rows[0];
          if (!row) return null;
          // Another account can't adopt an undo or learn its outcome.
          if (row.account_user_id !== user.userId || row.original_event_id !== input.sourceId) {
            throw keyReused();
          }
          return resultOf(row, true);
        };
        const early = await replay();
        if (early) return early;

        const original = await this.ownOriginal(client, user, input.sourceId, input.moverUserId);
        if (!original) throw new UndoBlocked('not_found');
        await client.query('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [
          original.storage_unit_id,
        ]);
        // A concurrent delivery of the same key may have committed while this one waited.
        const late = await replay();
        if (late) return late;

        const reason = await this.moveBlock(client, user, original, true);
        if (reason) throw new UndoBlocked(reason);

        const { rows: unit } = await client.query<{ version: number }>(
          'SELECT version FROM storage_unit WHERE id = $1',
          [original.storage_unit_id],
        );
        const result = await this.moves.moveInTransaction(
          client,
          {
            clientMoveId: input.idempotencyKey,
            storageUnitId: original.storage_unit_id,
            toLocationId: original.from_location_id,
            baseVersion: unit[0]!.version,
            scannedAt: this.clock.now().toISOString(),
            capturedOffline: false,
            captureContext: {
              stationId: original.station_id,
              accountId: user.userId,
              ...(original.mover_user_id ? { moverUserId: original.mover_user_id } : {}),
            },
          },
          user,
          requestId,
          { [UNDO_OF_MOVEMENT_EVENT_KEY]: original.id },
        );
        if (result.body.outcome !== 'saved' || result.body.replayed) {
          // The guards above make this unreachable; never commit a contested "undo".
          throw new UndoBlocked('changed_since');
        }
        await client.query(
          `INSERT INTO movement_reversal (original_event_id, reversal_event_id, idempotency_key,
                                          account_user_id)
           VALUES ($1, $2, $3, $4)`,
          [original.id, result.body.movementEventId, input.idempotencyKey, user.userId],
        );
        const saved = (await replay())!;
        return { ...saved, replayed: false };
      });
    } catch (error) {
      // Backstops for races the unit lock already serialises: one reversal per original, one
      // use of each key (a key that is also a move's ID is refused by the move itself).
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'movement_reversal_pkey') throw new UndoBlocked('already_undone');
      if (constraint === 'movement_reversal_idempotency_key_key') throw keyReused();
      throw error;
    }
  }

  /**
   * The caller's own saved move, or null (unknown, another account's, another LAB person's, a
   * contested attempt, a confirmation in place, or itself an undo): never revealed.
   */
  private async ownOriginal(
    db: Pool | PoolClient,
    user: AuthUser,
    sourceId: string,
    moverUserId: string | undefined,
  ): Promise<OriginalMove | null> {
    const { rows } = await db.query<OriginalMove>(
      `SELECT e.id, e.storage_unit_id, e.from_location_id, e.to_location_id, e.resulting_version,
              e.actor_user_id, e.mover_user_id, e.station_id, e.saved_at,
              EXISTS (SELECT 1 FROM movement_reversal r WHERE r.reversal_event_id = e.id)
                AS is_reversal
       FROM movement_event e
       WHERE e.id = $1 AND e.kind = 'move' AND e.actor_user_id = $2`,
      [sourceId, user.userId],
    );
    const original = rows[0];
    if (!original || original.is_reversal) return null;
    if (original.from_location_id === original.to_location_id) return null;
    if (user.accountType === 'shared_lab') {
      // Attribution only: the station must name the person the move was credited to.
      if (!moverUserId || moverUserId !== original.mover_user_id) return null;
    } else if (moverUserId !== undefined && moverUserId !== user.userId) {
      return null;
    }
    return original;
  }

  /**
   * Why the caller's move can't be undone now, or null. With `locked`, the unit is already held
   * FOR UPDATE and the previous location is locked FOR KEY SHARE (as a move locks its
   * destination) so a retirement can't slip in before the compensating move.
   */
  private async moveBlock(
    db: Pool | PoolClient,
    user: AuthUser,
    original: OriginalMove,
    locked: boolean,
  ): Promise<UndoBlockedReason | null> {
    const { rows: done } = await db.query(
      'SELECT 1 FROM movement_reversal WHERE original_event_id = $1',
      [original.id],
    );
    if (done.length > 0) return 'already_undone';

    // The session was checked by the guard; read the account again so a change made since
    // (disabled, sent back to pending) refuses here too.
    const { rows: account } = await db.query<{ status: string }>(
      'SELECT status FROM app_user WHERE id = $1',
      [user.userId],
    );
    if (account[0]?.status !== 'active' || !can(user, 'storage_unit.move')) {
      return 'not_permitted';
    }
    if (original.mover_user_id && !(await findActiveStaff(db, original.mover_user_id))) {
      return 'not_permitted';
    }

    if (this.clock.now().getTime() > original.saved_at.getTime() + WINDOW_MS) return 'expired';

    const { rows: units } = await db.query<{
      status: string;
      version: number;
      current_location_id: string;
    }>('SELECT status, version, current_location_id FROM storage_unit WHERE id = $1', [
      original.storage_unit_id,
    ]);
    const unit = units[0]!;
    if (unit.status !== 'in_stock') return 'record_locked';
    const { rows: conflicts } = await db.query(
      `SELECT 1 FROM location_conflict WHERE storage_unit_id = $1 AND status = 'open'`,
      [original.storage_unit_id],
    );
    if (conflicts.length > 0) return 'record_locked';

    if (
      unit.current_location_id !== original.to_location_id ||
      unit.version !== original.resulting_version
    ) {
      return 'changed_since';
    }

    const { rows: places } = await db.query<{ active: boolean }>(
      `SELECT active FROM location WHERE id = $1${locked ? ' FOR KEY SHARE' : ''}`,
      [original.from_location_id],
    );
    if (!places[0]?.active) return 'location_unavailable';
    return null;
  }

  /** Recipient only; LAB has no notifications. Not dismissed: nothing to undo. */
  private async notificationBlock(
    db: Pool | PoolClient,
    user: AuthUser,
    id: string,
  ): Promise<UndoBlockedReason | null> {
    if (user.accountType === 'shared_lab' || !can(user, 'notification.read')) return 'not_found';
    const { rows } = await db.query<{ dismissed: boolean }>(
      `SELECT dismissed_at IS NOT NULL AS dismissed FROM notification
       WHERE id = $1 AND recipient_user_id = $2`,
      [id, user.userId],
    );
    if (!rows[0]) return 'not_found';
    return rows[0].dismissed ? null : 'already_undone';
  }

  /**
   * Undo of a dismissal is the existing restore: it stays read and never reopens or resolves a
   * request. Restore is idempotent by state, so no key is stored: a retry after it succeeded
   * answers `already_undone`.
   */
  private async undoDismiss(user: AuthUser, id: string): Promise<UndoResult> {
    const reason = await this.notificationBlock(this.database.pool, user, id);
    if (reason) throw new UndoBlocked(reason);
    await this.notifications.restore(user, id);
    return {
      action: 'notification_dismiss',
      sourceId: id,
      // No separate event: the notification itself is what changed back.
      reversalEventId: id,
      undoneAt: this.clock.now().toISOString(),
      replayed: false,
      storageUnit: null,
      physicalReminder: null,
    };
  }
}
