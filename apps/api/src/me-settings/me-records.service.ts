import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SIDEBAR_PINS_MAX,
  SIDEBAR_RECENTS_MAX,
  type SidebarRecord,
  type SidebarRecordKind,
  type SidebarRecordList,
  type SidebarRecordRef,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { describeRecords, refKey } from './sidebar-records.js';

type Db = Pool | PoolClient;

interface Row {
  record_kind: SidebarRecordKind;
  record_id: string;
  at: Date;
}

/**
 * Pins (STRATA-11) and recents (STRATA-40): the signed-in person's own, by stable kind and ID.
 * Personal and test accounts only (`personal_settings.manage`; LAB is refused at the guard). A
 * person's writes are serialized by a transaction-scoped advisory lock on their ID, so the pin
 * limit and the recents trim hold under concurrent requests.
 */
@Injectable()
export class MeRecordsService {
  constructor(private readonly database: DatabaseService) {}

  pins(user: AuthUser): Promise<SidebarRecordList> {
    return this.listPins(this.database.pool, user);
  }

  /** Idempotent: pinning a pinned record keeps its place. 404 when it can't be opened. */
  async pin(user: AuthUser, ref: SidebarRecordRef): Promise<SidebarRecordList> {
    return withTransaction(this.database.pool, async (client) => {
      await lockPerson(client, 'person_pin', user.userId);
      await requireOpenable(client, user, ref);
      const { rows } = await client.query<{ pinned: boolean; total: number }>(
        `SELECT EXISTS (SELECT 1 FROM person_pin
                        WHERE user_id = $1 AND record_kind = $2 AND record_id = $3) AS pinned,
                (SELECT count(*)::int FROM person_pin WHERE user_id = $1) AS total`,
        [user.userId, ref.kind, ref.id],
      );
      const { pinned, total } = rows[0]!;
      if (!pinned) {
        if (total >= SIDEBAR_PINS_MAX) throw new ConflictException({ code: 'pin_limit' });
        await client.query(
          `INSERT INTO person_pin (user_id, record_kind, record_id, pinned_at)
           VALUES ($1, $2, $3, clock_timestamp())`,
          [user.userId, ref.kind, ref.id],
        );
      }
      return this.listPins(client, user);
    });
  }

  /** Idempotent, and works for a record that is gone or no longer openable. */
  async unpin(user: AuthUser, ref: SidebarRecordRef): Promise<SidebarRecordList> {
    return withTransaction(this.database.pool, async (client) => {
      await lockPerson(client, 'person_pin', user.userId);
      await client.query(
        'DELETE FROM person_pin WHERE user_id = $1 AND record_kind = $2 AND record_id = $3',
        [user.userId, ref.kind, ref.id],
      );
      return this.listPins(client, user);
    });
  }

  recents(user: AuthUser): Promise<SidebarRecordList> {
    return this.listRecents(this.database.pool, user);
  }

  /** Moves the record to the top (or adds it) and keeps the newest eight, in one transaction. */
  async addRecent(user: AuthUser, ref: SidebarRecordRef): Promise<SidebarRecordList> {
    return withTransaction(this.database.pool, async (client) => {
      await lockPerson(client, 'person_recent', user.userId);
      await requireOpenable(client, user, ref);
      await client.query(
        `INSERT INTO person_recent (user_id, record_kind, record_id, opened_at)
         VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (user_id, record_kind, record_id) DO UPDATE SET opened_at = EXCLUDED.opened_at`,
        [user.userId, ref.kind, ref.id],
      );
      await client.query(
        `DELETE FROM person_recent r
         WHERE r.user_id = $1
           AND (r.record_kind, r.record_id) NOT IN (
             SELECT k.record_kind, k.record_id FROM person_recent k
             WHERE k.user_id = $1
             ORDER BY k.opened_at DESC, k.record_kind, k.record_id
             LIMIT $2)`,
        [user.userId, SIDEBAR_RECENTS_MAX],
      );
      return this.listRecents(client, user);
    });
  }

  private async listPins(db: Db, user: AuthUser): Promise<SidebarRecordList> {
    const { rows } = await db.query<Row>(
      `SELECT record_kind, record_id, pinned_at AS at FROM person_pin
       WHERE user_id = $1 ORDER BY pinned_at, record_kind, record_id`,
      [user.userId],
    );
    return { items: await present(db, user, rows) };
  }

  private async listRecents(db: Db, user: AuthUser): Promise<SidebarRecordList> {
    const { rows } = await db.query<Row>(
      `SELECT record_kind, record_id, opened_at AS at FROM person_recent
       WHERE user_id = $1 ORDER BY opened_at DESC, record_kind, record_id LIMIT $2`,
      [user.userId, SIDEBAR_RECENTS_MAX],
    );
    return { items: await present(db, user, rows) };
  }
}

async function lockPerson(client: PoolClient, scope: string, userId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
    scope,
    userId,
  ]);
}

/** 404 for a record that doesn't exist or that the person can't open: the two look the same. */
async function requireOpenable(db: Db, user: AuthUser, ref: SidebarRecordRef): Promise<void> {
  const faces = await describeRecords(db, user, [ref]);
  if (!faces.has(refKey(ref))) throw new NotFoundException({ code: 'record_not_found' });
}

/** Each row with its record's face, rechecked now; unavailable rows carry nothing about it. */
async function present(db: Db, user: AuthUser, rows: Row[]): Promise<SidebarRecord[]> {
  const refs = rows.map((r) => ({ kind: r.record_kind, id: r.record_id }));
  const faces = await describeRecords(db, user, refs);
  return rows.map((row) => {
    const face = faces.get(refKey({ kind: row.record_kind, id: row.record_id }));
    return {
      kind: row.record_kind,
      id: row.record_id,
      available: face !== undefined,
      label: face?.label ?? null,
      name: face?.name ?? null,
      stage: face?.stage ?? null,
      href: face?.href ?? null,
      at: row.at.toISOString(),
    };
  });
}
