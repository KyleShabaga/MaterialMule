import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C05 (migration 0020): set and specimen detail, saved schedule snapshots, specimen dates
// that follow the casting time, casting corrections once numbered, Void metadata and the set
// command ledger, each rule proven in the database (test plan T1, T2, T3). Fictional data only.

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };

describe.runIf(testDatabaseUrl)('concrete specimen sets (MM-V2-C05, migration 0020)', () => {
  let db: TestSchema;
  let tech: string;
  let projectA: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    projectA = await insertProject(db.pool, 'DEMO-2601', tech);
  });

  afterAll(async () => {
    await db?.drop();
  });

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

  const report = (castAt: string | null = null) =>
    insert(db.pool, 'concrete_field_report', {
      project_id: projectA,
      created_by_user_id: tech,
      technician_user_id: tech,
      cast_at: castAt,
    });

  const SNAPSHOT = {
    default_ages: ['7', '28', '28', 'HOLD'],
    default_ages_source: 'lab_default',
    hold_duration_days: 56,
    hold_duration_source: 'lab_default',
  };

  const set = (reportId: string, values: Record<string, unknown> = {}) =>
    insert(db.pool, 'concrete_specimen_set', {
      project_id: projectA,
      field_report_id: reportId,
      created_by_user_id: tech,
      technician_user_id: tech,
      ...SNAPSHOT,
      ...values,
    });

  const specimen = (setId: string, letter: string, age: string) =>
    insert(db.pool, 'concrete_specimen', {
      project_id: projectA,
      set_id: setId,
      letter,
      assigned_age: age,
    });

  async function dates(setId: string) {
    const { rows } = await db.pool.query<{
      letter: string;
      assigned_age: string;
      target_date: string | null;
      hold_expires_on: string | null;
    }>(
      `SELECT letter, assigned_age, target_date::text, hold_expires_on::text
       FROM concrete_specimen WHERE set_id = $1 ORDER BY letter`,
      [setId],
    );
    return rows;
  }

  async function number(setId: string, permanentNumber: number, prefix = '26') {
    await db.pool.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [setId, permanentNumber, `${prefix}-${String(permanentNumber).padStart(2, '0')}`],
    );
  }

  let nextNumber = 0;
  const freshNumber = () => (nextNumber += 1);

  // ---------------------------------------------------------------------------------------------

  it('set detail: cylinder by default, mould blank until entered, snapshot all or none', async () => {
    const r = await report();
    const bare = await insert(db.pool, 'concrete_specimen_set', {
      project_id: projectA,
      field_report_id: r,
    });
    const { rows } = await db.pool.query(
      `SELECT specimen_type, mould_size, default_ages, hold_duration_days, voided_at
       FROM concrete_specimen_set WHERE id = $1`,
      [bare],
    );
    expect(rows[0]).toEqual({
      specimen_type: 'cylinder',
      mould_size: null,
      default_ages: null,
      hold_duration_days: null,
      voided_at: null,
    });
    await expect(set(r, { mould_size: '150 x 300' })).rejects.toMatchObject(REJECT);
    await expect(set(r, { specimen_type: 'core' })).rejects.toMatchObject(REJECT);
    await expect(set(r, { hold_duration_days: null })).rejects.toMatchObject(REJECT);
    // A mix source names its revision, and only a mix source does.
    await expect(set(r, { default_ages_source: 'mix' })).rejects.toMatchObject(REJECT);
    await expect(set(r, { default_ages: ['7', '0'] })).rejects.toMatchObject(REJECT);
    await expect(set(r, { mould_size: '150x300' })).resolves.toBeTruthy();
    await expect(set(r, { specimen_type: 'cube', mould_size: '50x50' })).resolves.toBeTruthy();
  });

  it('AC4: a saved schedule snapshot never changes', async () => {
    const s = await set(await report());
    await expect(
      db.pool.query(`UPDATE concrete_specimen_set SET default_ages = '{7,28}' WHERE id = $1`, [s]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_set_snapshot_fixed' });
    await expect(
      db.pool.query(`UPDATE concrete_specimen_set SET hold_duration_days = 90 WHERE id = $1`, [s]),
    ).rejects.toMatchObject(RESTRICT);
    // Other detail still edits.
    await db.pool.query(
      `UPDATE concrete_specimen_set SET mould_size = '100x200', version = version + 1 WHERE id = $1`,
      [s],
    );
  });

  it('the set technician is an active personal account', async () => {
    const r = await report();
    await expect(
      set(r, { technician_user_id: '00000000-0000-4000-8000-000000000001' }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_set_technician_check' });
  });

  it('AC1/AC2: specimens carry their own assigned age; repeats are separate rows', async () => {
    const s = await set(await report('2026-11-02T09:15:00-07:00'));
    for (const [letter, age] of [
      ['A', '7'],
      ['B', '28'],
      ['C', '28'],
      ['D', 'HOLD'],
    ] as const) {
      await specimen(s, letter, age);
    }
    expect(await dates(s)).toEqual([
      { letter: 'A', assigned_age: '7', target_date: '2026-11-09', hold_expires_on: null },
      { letter: 'B', assigned_age: '28', target_date: '2026-11-30', hold_expires_on: null },
      { letter: 'C', assigned_age: '28', target_date: '2026-11-30', hold_expires_on: null },
      { letter: 'D', assigned_age: 'HOLD', target_date: null, hold_expires_on: '2026-12-28' },
    ]);
    // No count column exists: the rows are the count.
    const { rows } = await db.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('concrete_specimen_set', 'concrete_specimen')
         AND column_name ~ 'count'`,
    );
    expect(rows).toEqual([]);
    await expect(specimen(s, 'E', '0')).rejects.toMatchObject(REJECT);
    await expect(specimen(s, 'E', '1000')).rejects.toMatchObject(REJECT);
    await expect(
      insert(db.pool, 'concrete_specimen', { project_id: projectA, set_id: s, letter: 'E' }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_assigned_age_required' });
  });

  it('T1: dates use the America/Edmonton calendar day of casting, across midnight and the year', async () => {
    // 23:30 on 31 December in Edmonton is already 1 January in UTC: the casting day is still
    // 31 December. Written as local time, so the test holds whatever offset the time-zone data
    // gives Alberta (tzdata 2026c: UTC−6 all year).
    const s = await set(await report('2026-12-31 23:30:00 America/Edmonton'), {
      hold_duration_days: 90,
      hold_duration_source: 'project',
    });
    await specimen(s, 'A', '7');
    await specimen(s, 'B', '28');
    await specimen(s, 'C', 'HOLD');
    expect(await dates(s)).toEqual([
      { letter: 'A', assigned_age: '7', target_date: '2027-01-07', hold_expires_on: null },
      { letter: 'B', assigned_age: '28', target_date: '2027-01-28', hold_expires_on: null },
      { letter: 'C', assigned_age: 'HOLD', target_date: null, hold_expires_on: '2027-03-31' },
    ]);
    // A client can't store a date that disagrees with the casting time and age.
    await db.pool.query(
      `UPDATE concrete_specimen SET target_date = '2030-01-01', hold_expires_on = NULL
       WHERE set_id = $1`,
      [s],
    );
    expect((await dates(s)).map((d) => d.target_date)).toEqual(['2027-01-07', '2027-01-28', null]);
    // Just after local midnight is the next casting day.
    const early = await set(await report('2027-01-01 00:15:00 America/Edmonton'));
    await specimen(early, 'A', '7');
    expect((await dates(early))[0]!.target_date).toBe('2027-01-08');
    // A Saturday target stays on the Saturday (the API flags it; nothing shifts it).
    const sat = await set(await report('2026-11-07T10:00:00-07:00'));
    await specimen(sat, 'A', '7');
    expect((await dates(sat))[0]!.target_date).toBe('2026-11-14');
  });

  it('dates follow the casting time on a draft: unknown → NULL, changed → recomputed', async () => {
    const r = await report();
    const s = await set(r);
    await specimen(s, 'A', '28');
    await specimen(s, 'B', 'HOLD');
    expect((await dates(s)).map((d) => [d.target_date, d.hold_expires_on])).toEqual([
      [null, null],
      [null, null],
    ]);
    await db.pool.query(
      `UPDATE concrete_field_report SET cast_at = '2026-11-03T08:00:00-07:00' WHERE id = $1`,
      [r],
    );
    expect((await dates(s)).map((d) => [d.target_date, d.hold_expires_on])).toEqual([
      ['2026-12-01', null],
      [null, '2026-12-29'],
    ]);
    // An unnumbered draft may change an assignment; the date follows.
    await db.pool.query(
      `UPDATE concrete_specimen SET assigned_age = '56' WHERE set_id = $1 AND letter = 'A'`,
      [s],
    );
    expect((await dates(s))[0]!.target_date).toBe('2026-12-29');
  });

  describe('AC5: numbered sets', () => {
    async function numbered(castAt: string) {
      const r = await report(castAt);
      const s = await set(r);
      await specimen(s, 'A', '28');
      await specimen(s, 'B', 'HOLD');
      await number(s, freshNumber());
      return { r, s };
    }

    async function correct(client: PoolClient, r: string, previous: string | null, next: string) {
      await insert(client, 'concrete_casting_correction', {
        project_id: projectA,
        field_report_id: r,
        previous_cast_at: previous,
        new_cast_at: next,
        reason: 'Casting time misread from the field sheet',
        effects: JSON.stringify([]),
        corrected_by_user_id: tech,
        corrected_by_name_snapshot: 'Test PE',
        idempotency_key: randomUUID(),
        request_hash: 'h',
      });
    }

    it('the casting time changes only with a correction in the same transaction', async () => {
      const castAt = '2026-12-31T10:00:00-07:00';
      const { r, s } = await numbered(castAt);
      const { rows: idBefore } = await db.pool.query(
        'SELECT permanent_id FROM concrete_specimen_set WHERE id = $1',
        [s],
      );
      await expect(
        db.pool.query(
          `UPDATE concrete_field_report SET cast_at = '2027-01-01T10:00:00-07:00' WHERE id = $1`,
          [r],
        ),
      ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_casting_correction_required' });

      // A correction recorded in another transaction doesn't count.
      const other = await db.pool.connect();
      try {
        await other.query('BEGIN');
        await correct(other, r, castAt, '2027-01-01T10:00:00-07:00');
        await other.query('COMMIT');
      } finally {
        other.release();
      }
      await expect(
        db.pool.query(
          `UPDATE concrete_field_report SET cast_at = '2027-01-01T10:00:00-07:00' WHERE id = $1`,
          [r],
        ),
      ).rejects.toMatchObject(REJECT);

      // A correction for another time doesn't count either.
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await correct(client, r, castAt, '2027-01-02T10:00:00-07:00');
        await expect(
          client.query(
            `UPDATE concrete_field_report SET cast_at = '2027-01-01T10:00:00-07:00' WHERE id = $1`,
            [r],
          ),
        ).rejects.toMatchObject(REJECT);
        await client.query('ROLLBACK');

        // The matching correction applies; dates follow; the issued ID stays (even across the year).
        await client.query('BEGIN');
        await correct(client, r, castAt, '2027-01-01T10:00:00-07:00');
        await client.query(
          `UPDATE concrete_field_report SET cast_at = '2027-01-01T10:00:00-07:00' WHERE id = $1`,
          [r],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect((await dates(s)).map((d) => [d.target_date, d.hold_expires_on])).toEqual([
        ['2027-01-29', null],
        [null, '2027-02-26'],
      ]);
      const { rows: idAfter } = await db.pool.query(
        'SELECT permanent_id FROM concrete_specimen_set WHERE id = $1',
        [s],
      );
      expect(idAfter).toEqual(idBefore);
    });

    it('corrections are append-only', async () => {
      const castAt = '2026-11-04T10:00:00-07:00';
      const { r } = await numbered(castAt);
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await correct(client, r, castAt, '2026-11-04T11:00:00-07:00');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await expect(
        db.pool.query(
          `UPDATE concrete_casting_correction SET reason = 'x' WHERE field_report_id = $1`,
          [r],
        ),
      ).rejects.toMatchObject(RESTRICT);
      await expect(
        db.pool.query('DELETE FROM concrete_casting_correction WHERE field_report_id = $1', [r]),
      ).rejects.toMatchObject(RESTRICT);
      await expect(db.pool.query('TRUNCATE concrete_casting_correction')).rejects.toMatchObject(
        RESTRICT,
      );
    });

    it('a numbered set keeps its specimens’ ages (rescheduling is C22)', async () => {
      const { s } = await numbered('2026-11-05T10:00:00-07:00');
      await expect(
        db.pool.query(`UPDATE concrete_specimen SET assigned_age = '56' WHERE set_id = $1`, [s]),
      ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_age_fixed' });
    });

    it('Void needs a permanent number and is final', async () => {
      const r = await report();
      const draft = await set(r);
      await expect(
        db.pool.query(
          `UPDATE concrete_specimen_set
           SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Cancelled' WHERE id = $1`,
          [draft, tech],
        ),
      ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_set_void_shape' });
      const { s } = await numbered('2026-11-06T10:00:00-07:00');
      await expect(
        db.pool.query(`UPDATE concrete_specimen_set SET voided_at = now() WHERE id = $1`, [s]),
      ).rejects.toMatchObject(REJECT);
      await db.pool.query(
        `UPDATE concrete_specimen_set
         SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Cancelled on site' WHERE id = $1`,
        [s, tech],
      );
      await expect(
        db.pool.query(
          `UPDATE concrete_specimen_set
           SET voided_at = NULL, voided_by_user_id = NULL, void_reason = NULL WHERE id = $1`,
          [s],
        ),
      ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_set_void_fixed' });
      await expect(
        db.pool.query('DELETE FROM concrete_specimen_set WHERE id = $1', [s]),
      ).rejects.toMatchObject(RESTRICT);
    });
  });

  it('the set command ledger is append-only', async () => {
    const r = await report();
    await db.pool.query(
      `INSERT INTO concrete_specimen_set_command
         (idempotency_key, field_report_id, set_id, kind, request_hash, user_id)
       VALUES ($1, $2, $3, 'create', 'h', $4)`,
      [randomUUID(), r, randomUUID(), tech],
    );
    await expect(
      db.pool.query(
        `UPDATE concrete_specimen_set_command SET kind = 'save' WHERE field_report_id = $1`,
        [r],
      ),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query('DELETE FROM concrete_specimen_set_command WHERE field_report_id = $1', [r]),
    ).rejects.toMatchObject(RESTRICT);
  });

  // T3: a full migrate from the baseline; allow for a loaded PC (as C03/C04/C27 do).
  describe('migration on a populated database', { timeout: 60_000 }, () => {
    let fresh: TestSchema;

    afterAll(async () => {
      await fresh?.drop();
    });

    async function snapshot(pool: Pool) {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migration' ORDER BY table_name`,
      );
      const out: Record<string, unknown[]> = {};
      for (const { table_name } of tables) {
        const { rows } = await pool.query(
          `SELECT row_to_json(t)::text AS row FROM "${table_name}" t ORDER BY 1`,
        );
        out[table_name] = rows.map((r: { row: string }) => r.row);
      }
      return out;
    }

    it('existing sets and specimens gain blank detail (no guessed age); nothing else changes', async () => {
      fresh = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        fresh.pool,
        all.filter((m) => m.version < '0020'),
      );
      await runSeed(fresh.pool, 'reference', 'test');
      await runSeed(fresh.pool, 'dev', 'test');
      const user = await insertUser(fresh.pool, 'MG');
      const project = await insertProject(fresh.pool, 'DEMO-2699', user);
      const r = await insert(fresh.pool, 'concrete_field_report', {
        project_id: project,
        created_by_user_id: user,
        cast_at: '2026-11-02T09:00:00-07:00',
      });
      const s = await insert(fresh.pool, 'concrete_specimen_set', {
        project_id: project,
        field_report_id: r,
      });
      await insert(fresh.pool, 'concrete_specimen', {
        project_id: project,
        set_id: s,
        letter: 'A',
      });
      const before = await snapshot(fresh.pool);

      expect(
        (
          await migrate(
            fresh.pool,
            all.filter((m) => m.version < '0021'),
          )
        ).applied,
      ).toEqual(['0020_concrete_specimen_sets']);

      const after = await snapshot(fresh.pool);
      expect(after.concrete_casting_correction).toEqual([]);
      expect(after.concrete_specimen_set_command).toEqual([]);
      delete after.concrete_casting_correction;
      delete after.concrete_specimen_set_command;
      for (const table of ['concrete_specimen_set', 'concrete_specimen'] as const) {
        const [row] = after[table] as string[];
        const [old] = before[table] as string[];
        const parsed = JSON.parse(row!) as Record<string, unknown>;
        expect(parsed).toMatchObject(JSON.parse(old!) as Record<string, unknown>);
        if (table === 'concrete_specimen') {
          expect(parsed).toMatchObject({
            assigned_age: null,
            target_date: null,
            hold_expires_on: null,
          });
        } else {
          expect(parsed).toMatchObject({
            specimen_type: 'cylinder',
            mould_size: null,
            default_ages: null,
            hold_duration_days: null,
            voided_at: null,
          });
        }
        delete after[table];
        delete before[table];
      }
      // Storage units, their annual counters, receipts and every other table are unchanged (T3).
      expect(after.storage_unit_annual_counter).toEqual(before.storage_unit_annual_counter);
      expect(after).toEqual(before);
    });
  });
});
