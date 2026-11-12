import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';

/** One stored area of `person_setting` (migration 0038). */
export type SettingArea = 'sidebar_layout' | 'preferences' | 'table_columns';

export interface StoredSetting {
  /** The stored document, or null when the person has never saved this area. */
  value: Record<string, unknown> | null;
  /** 0 when never saved. */
  version: number;
}

type Db = Pool | PoolClient;

export async function readSetting(
  db: Db,
  userId: string,
  area: SettingArea,
): Promise<StoredSetting> {
  const { rows } = await db.query<{ value: Record<string, unknown>; version: number }>(
    'SELECT value, version FROM person_setting WHERE user_id = $1 AND area = $2',
    [userId, area],
  );
  const row = rows[0];
  return row ? { value: row.value, version: row.version } : { value: null, version: 0 };
}

export type SaveResult =
  { saved: true; setting: StoredSetting } | { saved: false; current: StoredSetting };

/**
 * Optimistic save of one area. `next` builds the new document from the current one (null when
 * never saved). A version other than the current one saves nothing and returns the current
 * setting, so the caller can answer 409 with it. The row is locked for the read-modify-write,
 * and a first save that races another first save loses cleanly (ON CONFLICT DO NOTHING).
 */
export async function saveSetting(
  pool: Pool,
  userId: string,
  area: SettingArea,
  expectedVersion: number,
  next: (current: Record<string, unknown> | null) => Record<string, unknown>,
): Promise<SaveResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ value: Record<string, unknown>; version: number }>(
      'SELECT value, version FROM person_setting WHERE user_id = $1 AND area = $2 FOR UPDATE',
      [userId, area],
    );
    const row = rows[0];
    const current: StoredSetting = row
      ? { value: row.value, version: row.version }
      : { value: null, version: 0 };
    if (current.version !== expectedVersion) return { saved: false, current };
    const value = next(current.value);
    if (!row) {
      const inserted = await client.query<{ version: number }>(
        `INSERT INTO person_setting (user_id, area, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, area) DO NOTHING RETURNING version`,
        [userId, area, JSON.stringify(value)],
      );
      if (inserted.rows.length === 0) {
        return { saved: false, current: await readSetting(client, userId, area) };
      }
      return { saved: true, setting: { value, version: inserted.rows[0]!.version } };
    }
    const updated = await client.query<{ version: number }>(
      `UPDATE person_setting SET value = $3, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND area = $2 RETURNING version`,
      [userId, area, JSON.stringify(value)],
    );
    return { saved: true, setting: { value, version: updated.rows[0]!.version } };
  });
}
