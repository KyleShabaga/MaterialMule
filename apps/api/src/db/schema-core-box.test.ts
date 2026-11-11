import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import {
  PG,
  insertProject,
  insertReceipt,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { migrate } from './migrator.js';

// Core boxes (migration 0039, Kyle 2026-11-10): a CRE- core box belongs to exactly one test hole
// and holds 1 to 3 runs of 1.52 m; no other unit has runs. Fictional data only (DEMO-2601).

describe.runIf(testDatabaseUrl)('core box schema (migration 0039)', () => {
  let db: TestSchema;
  let userId: string;
  let locationId: string;
  let projectId: string;
  let holeA: string;
  let holeB: string;
  let receiptId: string;
  let sequence = 0;

  async function unit(
    client: PoolClient | TestSchema['pool'],
    values: Record<string, unknown> = {},
  ): Promise<string> {
    sequence += 1;
    const holder = (values.issued_holder_kind as string | undefined) ?? 'core_box';
    const prefix = holder === 'core_box' ? 'CRE' : 'BKT';
    const row = {
      readable_id: `${prefix}-2026-${String(sequence).padStart(6, '0')}`,
      id_prefix: prefix,
      issued_year: 2026,
      issued_holder_kind: holder,
      receipt_id: receiptId,
      project_id: projectId,
      unit_type: 'core_box',
      holder_kind: 'core_box',
      core_run_count: 3,
      current_location_id: locationId,
      received_date: '2026-11-10',
      ...values,
    };
    const keys = Object.keys(row);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO storage_unit (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  async function summary(
    client: PoolClient | TestSchema['pool'],
    storageUnitId: string,
    testHoleId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id, summary_type)
       VALUES ($1, $2, $3, 'all')`,
      [storageUnitId, projectId, testHoleId],
    );
  }

  /** Runs `work` in one transaction and returns what COMMIT (or the work) threw, if anything. */
  async function transaction(work: (client: PoolClient) => Promise<void>): Promise<unknown> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await work(client);
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK');
        return error;
      }
    } finally {
      client.release();
    }
  }

  /** A committed core box with one summary on `hole`. */
  async function coreBox(runs = 3, hole = holeA): Promise<string> {
    let id = '';
    const error = await transaction(async (client) => {
      id = await unit(client, { core_run_count: runs });
      await summary(client, id, hole);
    });
    expect(error).toBeNull();
    return id;
  }

  const runs = async (id: string) =>
    (
      await db.pool.query<{ core_run_count: number | null }>(
        'SELECT core_run_count FROM storage_unit WHERE id = $1',
        [id],
      )
    ).rows[0]!.core_run_count;

  beforeAll(async () => {
    db = await createTestSchema();
    await migrate(db.pool);
    userId = await insertUser(db.pool);
    locationId = await receivingLabId(db.pool);
    projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    holeA = await insertTestHole(db.pool, projectId, 'TH26-01');
    holeB = await insertTestHole(db.pool, projectId, 'TH26-02');
    receiptId = await insertReceipt(db.pool, projectId, userId, 50);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('stores a core box of 1, 2 or 3 runs on one test hole', async () => {
    for (const count of [3, 2, 1]) {
      expect(await runs(await coreBox(count))).toBe(count);
    }
  });

  it('refuses a run count other than 1, 2 or 3', async () => {
    for (const count of [0, 4, -1]) {
      await expect(unit(db.pool, { core_run_count: count })).rejects.toMatchObject({
        code: PG.checkViolation,
        constraint: 'storage_unit_core_run_count_check',
      });
    }
  });

  it('requires runs on a core box and refuses them on any other unit', async () => {
    await expect(unit(db.pool, { core_run_count: null })).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_core_runs_by_type_check',
    });
    await expect(
      unit(db.pool, {
        issued_holder_kind: 'bucket',
        unit_type: 'bucket',
        holder_kind: 'bucket',
        core_run_count: 3,
      }),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_core_runs_by_type_check',
    });
  });

  it('keeps a core box in a core box holder with no own source or bulk group', async () => {
    await expect(unit(db.pool, { holder_kind: 'bucket' })).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_type_matches_holder_check',
    });
    await expect(
      unit(db.pool, { source_type: 'test_hole', source_test_hole_id: holeA }),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_contents_by_type_check',
    });
  });

  it('refuses at commit a core box with no test hole or with two', async () => {
    const none = await transaction(async (client) => {
      await unit(client);
    });
    expect(none).toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_core_box_one_test_hole',
    });

    const two = await transaction(async (client) => {
      const id = await unit(client);
      await summary(client, id, holeA);
      await summary(client, id, holeB);
    });
    expect(two).toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_core_box_one_test_hole',
    });

    // A committed box can't gain a second hole or lose its only one.
    const box = await coreBox();
    expect(await transaction((client) => summary(client, box, holeB))).toMatchObject({
      constraint: 'storage_unit_core_box_one_test_hole',
    });
    expect(
      await transaction(async (client) => {
        await client.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [
          box,
        ]);
      }),
    ).toMatchObject({ constraint: 'storage_unit_core_box_one_test_hole' });
  });

  it('lets a correction replace the hole and change the runs, and keeps the ID', async () => {
    const box = await coreBox(3);
    const error = await transaction(async (client) => {
      await client.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [box]);
      await summary(client, box, holeB);
      await client.query('UPDATE storage_unit SET core_run_count = 2 WHERE id = $1', [box]);
    });
    expect(error).toBeNull();
    const { rows } = await db.pool.query<{ readable_id: string; core_run_count: number }>(
      'SELECT readable_id, core_run_count FROM storage_unit WHERE id = $1',
      [box],
    );
    expect(rows[0]).toMatchObject({ core_run_count: 2 });
    expect(rows[0]!.readable_id).toMatch(/^CRE-2026-\d{6}$/);
  });

  it('turns a bucket into a core box only with runs and exactly one test hole', async () => {
    const twoHoles = await unit(db.pool, {
      issued_holder_kind: 'bucket',
      unit_type: 'bucket',
      holder_kind: 'bucket',
      core_run_count: null,
    });
    await summary(db.pool, twoHoles, holeA);
    await summary(db.pool, twoHoles, holeB);
    expect(
      await transaction(async (client) => {
        await client.query(
          `UPDATE storage_unit SET unit_type = 'core_box', holder_kind = 'core_box',
                                   core_run_count = 3 WHERE id = $1`,
          [twoHoles],
        );
      }),
    ).toMatchObject({ constraint: 'storage_unit_core_box_one_test_hole' });

    await db.pool.query(
      'DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1 AND test_hole_id = $2',
      [twoHoles, holeB],
    );
    expect(
      await transaction(async (client) => {
        await client.query(
          `UPDATE storage_unit SET unit_type = 'core_box', holder_kind = 'core_box',
                                   core_run_count = 3 WHERE id = $1`,
          [twoHoles],
        );
      }),
    ).toBeNull();
    // Its BKT- ID stays: the issued holder never changes.
    const { rows } = await db.pool.query<{ readable_id: string }>(
      'SELECT readable_id FROM storage_unit WHERE id = $1',
      [twoHoles],
    );
    expect(rows[0]!.readable_id).toMatch(/^BKT-/);
  });

  it("refuses changing a disposed core box's runs", async () => {
    const box = await coreBox(3);
    await db.pool.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now(), disposed_by_user_id = $2
       WHERE id = $1`,
      [box, userId],
    );
    await expect(
      db.pool.query('UPDATE storage_unit SET core_run_count = 2 WHERE id = $1', [box]),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_disposed_core_runs_final',
    });
    expect(await runs(box)).toBe(3);
  });
});
