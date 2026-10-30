import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';

// BUG-014 (owner decision 2026-10-30): a disposed unit's project, type and test-hole summaries
// are final, whatever writes them. Fictional data only: DEMO-2601 / DEMO-2602, TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('disposed storage unit contents are final (BUG-014)', () => {
  let db: TestSchema;
  let projectA: string;
  let projectB: string;
  let holeA1: string;
  let holeA2: string;
  let holeB1: string;
  let receiptId: string;
  let locationId: string;
  let sequence = 0;

  const constraint = 'storage_unit_disposed_contents_final';

  /** A bucket in DEMO-2601 summarised from TH26-01; disposed with a recorded disposal if asked. */
  async function bucket(disposed: boolean): Promise<{ id: string; summaryId: string }> {
    sequence += 1;
    const id = await insertStorageUnit(
      db.pool,
      { projectId: projectA, receiptId, locationId },
      { readableId: `BKT-2026-${String(sequence).padStart(6, '0')}` },
    );
    const summaryId = await insertSummary(
      db.pool,
      { storageUnitId: id, projectId: projectA, testHoleId: holeA1 },
      { type: 'all' },
    );
    if (disposed) {
      await db.pool.query(
        `UPDATE storage_unit SET status = 'disposed', disposed_at = now() WHERE id = $1`,
        [id],
      );
    }
    return { id, summaryId };
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const user = await insertUser(db.pool);
    projectA = await insertProject(db.pool, 'DEMO-2601', user);
    projectB = await insertProject(db.pool, 'DEMO-2602', user);
    holeA1 = await insertTestHole(db.pool, projectA, 'TH26-01');
    holeA2 = await insertTestHole(db.pool, projectA, 'TH26-02');
    holeB1 = await insertTestHole(db.pool, projectB, 'TH26-01');
    receiptId = await insertReceipt(db.pool, projectA, user);
    locationId = await receivingLabId(db.pool);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("refuses a change to a disposed unit's project, type or holder", async () => {
    const unit = await bucket(true);
    for (const sql of [
      `UPDATE storage_unit SET unit_type = 'shelby_tube', holder_kind = 'shelby_tube' WHERE id = $1`,
      `UPDATE storage_unit SET holder_kind = 'generic' WHERE id = $1`,
    ]) {
      await expect(db.pool.query(sql, [unit.id])).rejects.toMatchObject({ constraint });
    }
    // A project change has to move the summaries too; inside one transaction both are refused.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(`UPDATE storage_unit SET project_id = $2 WHERE id = $1`, [unit.id, projectB]),
      ).rejects.toMatchObject({ constraint });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const { rows } = await db.pool.query(
      'SELECT project_id, unit_type, holder_kind FROM storage_unit WHERE id = $1',
      [unit.id],
    );
    expect(rows[0]).toEqual({ project_id: projectA, unit_type: 'bucket', holder_kind: 'bucket' });
  });

  it("refuses inserting, editing or deleting a disposed unit's hole summaries", async () => {
    const unit = await bucket(true);
    await expect(
      insertSummary(
        db.pool,
        { storageUnitId: unit.id, projectId: projectA, testHoleId: holeA2 },
        { type: 'all' },
      ),
    ).rejects.toMatchObject({ constraint });
    await expect(
      db.pool.query(
        `UPDATE storage_unit_hole_summary SET summary_type = 'custom', custom_text = 'x'
         WHERE id = $1`,
        [unit.summaryId],
      ),
    ).rejects.toMatchObject({ constraint });
    await expect(
      db.pool.query('DELETE FROM storage_unit_hole_summary WHERE id = $1', [unit.summaryId]),
    ).rejects.toMatchObject({ constraint });
    // Moving another unit's summary onto the disposed unit is an insert into its set.
    const other = await bucket(false);
    await expect(
      db.pool.query(`UPDATE storage_unit_hole_summary SET storage_unit_id = $2 WHERE id = $1`, [
        other.summaryId,
        unit.id,
      ]),
    ).rejects.toMatchObject({ constraint });
    const { rows } = await db.pool.query(
      'SELECT id, test_hole_id, summary_type FROM storage_unit_hole_summary WHERE storage_unit_id = $1',
      [unit.id],
    );
    expect(rows).toEqual([{ id: unit.summaryId, test_hole_id: holeA1, summary_type: 'all' }]);
  });

  it('keeps in-stock corrections, a disposed unit’s note and date, and fixture seeding working', async () => {
    const live = await bucket(false);
    await db.pool.query(`UPDATE storage_unit_hole_summary SET summary_type = 'all' WHERE id = $1`, [
      live.summaryId,
    ]);
    await db.pool.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [
      live.id,
    ]);
    await db.pool.query(`UPDATE storage_unit SET project_id = $2 WHERE id = $1`, [
      live.id,
      projectB,
    ]);
    await insertSummary(
      db.pool,
      { storageUnitId: live.id, projectId: projectB, testHoleId: holeB1 },
      { type: 'all' },
    );

    const disposed = await bucket(true);
    await db.pool.query(
      `UPDATE storage_unit SET note = 'Lid replaced', received_date = '2026-10-21' WHERE id = $1`,
      [disposed.id],
    );

    // Dev and bench fixtures insert a unit already marked disposed (no recorded disposal) and
    // then its summaries.
    sequence += 1;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, status)
       VALUES ($1, 'BKT', 2026, 'bucket', $2, $3, 'bucket', 'bucket', $4, '2024-10-23', 'disposed')
       RETURNING id`,
      [`BKT-2026-${String(sequence).padStart(6, '0')}`, receiptId, projectA, locationId],
    );
    await insertSummary(
      db.pool,
      { storageUnitId: rows[0]!.id, projectId: projectA, testHoleId: holeA1 },
      { type: 'all' },
    );
  });
});
