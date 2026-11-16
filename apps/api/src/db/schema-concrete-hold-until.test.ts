import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';

// STRATA-121 (migration 0045): Hold until a date from Breaks. A specimen's hold-until date is
// written only with its history row, only while it is on HOLD; a numbered set's scheduled
// specimen goes to HOLD only with that row; the HOLD expiry follows the chosen date (not the
// casting time) and a release by Schedule test clears it. Fictional data only (DEMO- projects,
// Test initials). Casting 2 Nov 2026 09:15 in Edmonton (UTC-6): 7 d → 9 Nov, 28 d → 30 Nov,
// HOLD 56 d → 28 Dec.

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };

async function insert(
  pool: Pool | PoolClient,
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const columns = Object.keys(row);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0]!.id;
}

describe.runIf(testDatabaseUrl)('concrete Hold until (STRATA-121, migration 0045)', () => {
  let db: TestSchema;
  let pe: string;
  let project: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createMigratedSchema();
    pe = await insertUser(db.pool, 'PE');
    project = await insertProject(db.pool, 'DEMO-2601', pe);
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A report cast 2 Nov 2026 with one set: A 7 d, B 28 d, C HOLD. */
  async function castSet(numbered: boolean) {
    const reportId = await insert(db.pool, 'concrete_field_report', {
      project_id: project,
      created_by_user_id: pe,
      technician_user_id: pe,
      cast_at: '2026-11-02T09:15:00-06:00',
    });
    const setId = await insert(db.pool, 'concrete_specimen_set', {
      project_id: project,
      field_report_id: reportId,
      created_by_user_id: pe,
      technician_user_id: pe,
      default_ages: ['7', '28', 'HOLD'],
      default_ages_source: 'lab_default',
      hold_duration_days: 56,
      hold_duration_source: 'lab_default',
    });
    const ids: string[] = [];
    for (const [letter, age] of [
      ['A', '7'],
      ['B', '28'],
      ['C', 'HOLD'],
    ] as const) {
      ids.push(
        await insert(db.pool, 'concrete_specimen', {
          project_id: project,
          set_id: setId,
          letter,
          assigned_age: age,
        }),
      );
    }
    if (numbered) {
      counter += 1;
      await db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [setId, counter, `26-${String(counter).padStart(2, '0')}`],
      );
    }
    return { reportId, setId, ids };
  }

  async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const command = (client: Pool | PoolClient, kind = 'hold_until', specimens: string[] = []) =>
    insert(client, 'concrete_hold_command', {
      idempotency_key: randomUUID(),
      kind,
      request_hash: 'test',
      account_user_id: pe,
      specimen_ids: specimens.length > 0 ? specimens : [randomUUID()],
    });

  const assignment = async (
    client: PoolClient,
    specimenId: string,
    values: { previous_age?: string; previous_target_date?: string; hold_until?: string } = {},
  ) =>
    insert(client, 'concrete_specimen_hold_assignment', {
      project_id: project,
      specimen_id: specimenId,
      command_id: await command(client, 'hold_until', [specimenId]),
      previous_age: '28',
      previous_target_date: '2026-11-30',
      hold_until: '2027-03-01',
      reason: 'Owner asked to keep it',
      assigned_by_user_id: pe,
      assigned_by_name_snapshot: 'Test PE',
      ...values,
    });

  const dates = async (id: string) =>
    (
      await db.pool.query<{
        age: string;
        target: string | null;
        hold: string | null;
        until: string | null;
      }>(
        `SELECT assigned_age AS age, target_date::text AS target, hold_expires_on::text AS hold,
                hold_until::text AS until
         FROM concrete_specimen WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it('a numbered set’s scheduled specimen goes to HOLD only with its Hold until row', async () => {
    const { ids } = await castSet(true);
    const b = ids[1]!;
    // No row: the age is fixed in a numbered set.
    await expect(
      db.pool.query(`UPDATE concrete_specimen SET assigned_age = 'HOLD' WHERE id = $1`, [b]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_age_fixed' });
    // A row for a different previous age doesn't match.
    await expect(
      inTransaction(async (client) => {
        await assignment(client, b, { previous_age: '7' });
        await client.query(
          `UPDATE concrete_specimen SET assigned_age = 'HOLD', hold_until = '2027-03-01'
           WHERE id = $1`,
          [b],
        );
      }),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_age_fixed' });
    // The matching row: the HOLD expiry is the chosen date, not casting + 56 days.
    await inTransaction(async (client) => {
      await assignment(client, b);
      await client.query(
        `UPDATE concrete_specimen SET assigned_age = 'HOLD', hold_until = '2027-03-01'
         WHERE id = $1`,
        [b],
      );
    });
    expect(await dates(b)).toEqual({
      age: 'HOLD',
      target: null,
      hold: '2027-03-01',
      until: '2027-03-01',
    });
  });

  it('a hold-until date is written only with a history row for exactly that date', async () => {
    const { ids } = await castSet(false);
    const c = ids[2]!;
    await expect(
      db.pool.query(`UPDATE concrete_specimen SET hold_until = '2027-02-01' WHERE id = $1`, [c]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_hold_until_recorded' });
    await expect(
      inTransaction(async (client) => {
        await assignment(client, c, { hold_until: '2027-02-02' });
        await client.query(`UPDATE concrete_specimen SET hold_until = '2027-02-01' WHERE id = $1`, [
          c,
        ]);
      }),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_hold_until_recorded' });
    // A row committed earlier doesn't count for a later transaction.
    await inTransaction(async (client) => assignment(client, c, { hold_until: '2027-02-03' }));
    await expect(
      db.pool.query(`UPDATE concrete_specimen SET hold_until = '2027-02-03' WHERE id = $1`, [c]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_hold_until_recorded' });
    // A new specimen never starts with one.
    const { setId } = await castSet(false);
    await expect(
      insert(db.pool, 'concrete_specimen', {
        project_id: project,
        set_id: setId,
        letter: 'D',
        assigned_age: 'HOLD',
        hold_until: '2027-02-01',
      }),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_hold_until_recorded' });
    expect((await dates(c))!.until).toBeNull();
  });

  it('only a HOLD specimen keeps a hold-until date; Schedule test clears it', async () => {
    const { ids } = await castSet(true);
    const b = ids[1]!;
    // On an age in days the dates trigger drops it (and the check backs that up).
    await inTransaction(async (client) => {
      await assignment(client, b, { hold_until: '2027-04-01' });
      await client.query(`UPDATE concrete_specimen SET hold_until = '2027-04-01' WHERE id = $1`, [
        b,
      ]);
    });
    expect(await dates(b)).toMatchObject({ age: '28', until: null, target: '2026-11-30' });
    // Without the trigger, the check refuses it (rolled back, so the trigger stays enabled).
    await expect(
      inTransaction(async (client) => {
        await assignment(client, b, { hold_until: '2027-04-01' });
        await client.query('ALTER TABLE concrete_specimen DISABLE TRIGGER concrete_specimen_dates');
        await client.query(`UPDATE concrete_specimen SET hold_until = '2027-04-01' WHERE id = $1`, [
          b,
        ]);
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_hold_until_kind' });

    // Held until a date, then released by Schedule test (C26): the date goes, the target follows.
    await inTransaction(async (client) => {
      await assignment(client, b, { hold_until: '2027-04-02' });
      await client.query(
        `UPDATE concrete_specimen SET assigned_age = 'HOLD', hold_until = '2027-04-02'
         WHERE id = $1`,
        [b],
      );
    });
    await inTransaction(async (client) => {
      await insert(client, 'concrete_specimen_hold_schedule', {
        project_id: project,
        specimen_id: b,
        command_id: await command(client, 'schedule_test', [b]),
        previous_hold_expires_on: '2027-04-02',
        new_age: '56',
        new_target_date: '2026-12-28',
        reason: 'Test it after all',
        scheduled_by_user_id: pe,
        scheduled_by_name_snapshot: 'Test PE',
      });
      await client.query(`UPDATE concrete_specimen SET assigned_age = '56' WHERE id = $1`, [b]);
    });
    expect(await dates(b)).toEqual({ age: '56', target: '2026-12-28', hold: null, until: null });
  });

  it('a casting change moves the default HOLD expiry, never a chosen hold-until date', async () => {
    const { reportId, ids } = await castSet(false);
    const [, b, c] = ids;
    await inTransaction(async (client) => {
      await assignment(client, b!, { hold_until: '2027-05-01' });
      await client.query(
        `UPDATE concrete_specimen SET assigned_age = 'HOLD', hold_until = '2027-05-01'
         WHERE id = $1`,
        [b],
      );
    });
    await db.pool.query(
      `UPDATE concrete_field_report SET cast_at = '2026-11-05T09:15:00-06:00' WHERE id = $1`,
      [reportId],
    );
    expect((await dates(b!))!.hold).toBe('2027-05-01');
    expect((await dates(c!))!.hold).toBe('2026-12-31');
  });

  it('Hold until history is append-only and the ledger accepts its kind', async () => {
    const { ids } = await castSet(false);
    const id = await inTransaction((client) => assignment(client, ids[0]!, { previous_age: '7' }));
    await expect(
      db.pool.query(
        `UPDATE concrete_specimen_hold_assignment SET reason = 'changed' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query('DELETE FROM concrete_specimen_hold_assignment WHERE id = $1', [id]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      inTransaction(async (client) => assignment(client, ids[0]!, { previous_age: 'HOLD' })),
    ).rejects.toMatchObject(REJECT);
    await expect(
      inTransaction(async (client) => assignment(client, ids[0]!, { reason: ' ' } as never)),
    ).rejects.toMatchObject(REJECT);
    await expect(command(db.pool, 'hold_forever')).rejects.toMatchObject(REJECT);
    await expect(command(db.pool, 'hold_until')).resolves.toBeDefined();
  });
});
