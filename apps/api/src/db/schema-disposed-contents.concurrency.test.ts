import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

// PR #104 review finding 1: the hole-summary backstop must not let a summary change slip past a
// disposal committing at the same time. Each case runs two real transactions and orders them by
// observing PostgreSQL's lock waits (pg_blocking_pids), never by sleeping. Fictional data only:
// DEMO-2601, TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('disposed-unit summary guard under concurrency (BUG-014)', () => {
  let db: TestSchema;
  let projectId: string;
  let holes: string[];
  let receiptId: string;
  let locationId: string;
  let sequence = 0;
  const constraint = 'storage_unit_disposed_contents_final';

  async function bucket(): Promise<{ id: string; summaryId: string }> {
    sequence += 1;
    const id = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId },
      { readableId: `BKT-2026-${String(sequence).padStart(6, '0')}` },
    );
    const summaryId = await insertSummary(
      db.pool,
      { storageUnitId: id, projectId, testHoleId: holes[0]! },
      { type: 'all' },
    );
    return { id, summaryId };
  }

  /** A transaction on its own connection, with its backend pid for lock observation. */
  async function begin(): Promise<{ client: PoolClient; pid: number }> {
    const client = await db.pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return { client, pid: rows[0]!.pid };
  }

  async function end(tx: { client: PoolClient }) {
    await tx.client.query('ROLLBACK').catch(() => undefined);
    tx.client.release();
  }

  /** Resolves once the backend `waiter` is blocked by the backend `holder`. */
  async function waitUntilBlocked(waiter: number, holder: number) {
    await vi.waitFor(
      async () => {
        const { rows } = await db.pool.query<{ blocked: boolean }>(
          'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
          [waiter, holder],
        );
        expect(rows[0]!.blocked).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  /** The disposal routes' write: lock the unit, then mark it disposed (uncommitted). */
  async function disposeUncommitted(tx: { client: PoolClient }, unitId: string) {
    await tx.client.query('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unitId]);
    await tx.client.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now(), version = version + 1
       WHERE id = $1`,
      [unitId],
    );
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const user = await insertUser(db.pool);
    projectId = await insertProject(db.pool, 'DEMO-2601', user);
    holes = [
      await insertTestHole(db.pool, projectId, 'TH26-01'),
      await insertTestHole(db.pool, projectId, 'TH26-02'),
    ];
    receiptId = await insertReceipt(db.pool, projectId, user);
    locationId = await receivingLabId(db.pool);
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('disposal commits first: the summary change waits, then is refused', () => {
    const cases: [
      string,
      (unit: { id: string; summaryId: string }) => Promise<[string, unknown[]]>,
    ][] = [
      [
        'insert',
        async (unit) => [
          `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                    summary_type)
             VALUES ($1, $2, $3, 'all')`,
          [unit.id, projectId, holes[1]],
        ],
      ],
      [
        'update',
        async (unit) => [
          `UPDATE storage_unit_hole_summary SET summary_type = 'custom', custom_text = 'x'
             WHERE id = $1`,
          [unit.summaryId],
        ],
      ],
      [
        'delete',
        async (unit) => ['DELETE FROM storage_unit_hole_summary WHERE id = $1', [unit.summaryId]],
      ],
      [
        'move onto the unit',
        async (unit) => {
          // Another unit's summary, on a hole the disposed unit doesn't have yet.
          const other = await insertStorageUnit(
            db.pool,
            { projectId, receiptId, locationId },
            { readableId: `BKT-2026-${String((sequence += 1)).padStart(6, '0')}` },
          );
          const moving = await insertSummary(
            db.pool,
            { storageUnitId: other, projectId, testHoleId: holes[1]! },
            { type: 'all' },
          );
          return [
            'UPDATE storage_unit_hole_summary SET storage_unit_id = $2 WHERE id = $1',
            [moving, unit.id],
          ];
        },
      ],
    ];
    for (const [name, statement] of cases) {
      it(name, async () => {
        const unit = await bucket();
        const [sql, params] = await statement(unit);
        const before = await db.pool.query('SELECT * FROM storage_unit_hole_summary ORDER BY id');
        const disposal = await begin();
        const writer = await begin();
        try {
          await disposeUncommitted(disposal, unit.id);
          const writing = writer.client.query(sql, params).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          await waitUntilBlocked(writer.pid, disposal.pid);
          await disposal.client.query('COMMIT');
          const outcome = await writing;
          expect(outcome.ok).toBe(false);
          expect(outcome.ok ? null : outcome.error).toMatchObject({ constraint });
        } finally {
          await end(disposal);
          await end(writer);
        }
        const after = await db.pool.query('SELECT * FROM storage_unit_hole_summary ORDER BY id');
        expect(after.rows).toEqual(before.rows);
      });
    }

    it('move off the unit', async () => {
      const unit = await bucket();
      const other = await bucket();
      // Moving the disposed unit's summary away changes its set as well.
      await db.pool.query('DELETE FROM storage_unit_hole_summary WHERE id = $1', [other.summaryId]);
      const disposal = await begin();
      const writer = await begin();
      try {
        await disposeUncommitted(disposal, unit.id);
        const writing = writer.client
          .query('UPDATE storage_unit_hole_summary SET storage_unit_id = $2 WHERE id = $1', [
            unit.summaryId,
            other.id,
          ])
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        await waitUntilBlocked(writer.pid, disposal.pid);
        await disposal.client.query('COMMIT');
        const outcome = await writing;
        expect(outcome.ok ? null : outcome.error).toMatchObject({ constraint });
      } finally {
        await end(disposal);
        await end(writer);
      }
      const { rows } = await db.pool.query(
        'SELECT storage_unit_id FROM storage_unit_hole_summary WHERE id = $1',
        [unit.summaryId],
      );
      expect(rows).toEqual([{ storage_unit_id: unit.id }]);
    });
  });

  describe('the summary change commits first: disposal waits for it', () => {
    for (const op of ['insert', 'update', 'delete'] as const) {
      it(op, async () => {
        const unit = await bucket();
        const writer = await begin();
        const disposal = await begin();
        try {
          if (op === 'insert') {
            await writer.client.query(
              `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                      summary_type)
               VALUES ($1, $2, $3, 'all')`,
              [unit.id, projectId, holes[1]],
            );
          } else if (op === 'update') {
            await writer.client.query(
              `UPDATE storage_unit_hole_summary SET summary_type = 'custom', custom_text = 'x'
               WHERE id = $1`,
              [unit.summaryId],
            );
          } else {
            await writer.client.query('DELETE FROM storage_unit_hole_summary WHERE id = $1', [
              unit.summaryId,
            ]);
          }
          const disposing = disposeUncommitted(disposal, unit.id);
          await waitUntilBlocked(disposal.pid, writer.pid);
          await writer.client.query('COMMIT');
          await disposing;
          await disposal.client.query('COMMIT');
        } finally {
          await end(writer);
          await end(disposal);
        }
        const { rows } = await db.pool.query<{ status: string; n: number }>(
          `SELECT su.status, (SELECT count(*)::int FROM storage_unit_hole_summary h
                              WHERE h.storage_unit_id = su.id) AS n
           FROM storage_unit su WHERE su.id = $1`,
          [unit.id],
        );
        // The change made before the disposal stands; the unit is disposed after it.
        expect(rows[0]).toEqual({
          status: 'disposed',
          n: op === 'insert' ? 2 : op === 'delete' ? 0 : 1,
        });
      });
    }

    it('a move between two units locks both in id order and holds off a disposal of either', async () => {
      const a = await bucket();
      const b = await bucket();
      await db.pool.query('DELETE FROM storage_unit_hole_summary WHERE id = $1', [b.summaryId]);
      const writer = await begin();
      const disposal = await begin();
      try {
        await writer.client.query(
          'UPDATE storage_unit_hole_summary SET storage_unit_id = $2 WHERE id = $1',
          [a.summaryId, b.id],
        );
        // Both parents are share-locked by the moving transaction: neither can be taken for
        // update without waiting.
        for (const id of [a.id, b.id]) {
          const probe = await begin();
          try {
            await expect(
              probe.client.query('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE NOWAIT', [
                id,
              ]),
            ).rejects.toMatchObject({ code: '55P03' });
          } finally {
            await end(probe);
          }
        }
        const disposing = disposeUncommitted(disposal, a.id);
        await waitUntilBlocked(disposal.pid, writer.pid);
        await writer.client.query('COMMIT');
        await disposing;
        await disposal.client.query('COMMIT');
      } finally {
        await end(writer);
        await end(disposal);
      }
    });
  });

  it('corrections and fixture seeding still work', async () => {
    // A correction holds the unit FOR UPDATE, then rewrites its summaries (the API's order).
    const unit = await bucket();
    const tx = await begin();
    try {
      await tx.client.query('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit.id]);
      await tx.client.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [
        unit.id,
      ]);
      await tx.client.query(
        `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                summary_type)
         VALUES ($1, $2, $3, 'all')`,
        [unit.id, projectId, holes[1]],
      );
      await tx.client.query(
        'UPDATE storage_unit SET note = $2, version = version + 1 WHERE id = $1',
        [unit.id, 'Lid replaced'],
      );
      await tx.client.query('COMMIT');
    } finally {
      await end(tx);
    }

    // Dev and bench fixtures: a unit inserted already disposed (no disposed_at), then its summary.
    sequence += 1;
    const seed = await begin();
    try {
      const { rows } = await seed.client.query<{ id: string }>(
        `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                   receipt_id, project_id, unit_type, holder_kind,
                                   current_location_id, received_date, status)
         VALUES ($1, 'BKT', 2026, 'bucket', $2, $3, 'bucket', 'bucket', $4, '2024-10-23',
                 'disposed')
         RETURNING id`,
        [`BKT-2026-${String(sequence).padStart(6, '0')}`, receiptId, projectId, locationId],
      );
      await seed.client.query(
        `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                summary_type)
         VALUES ($1, $2, $3, 'all')`,
        [rows[0]!.id, projectId, holes[0]],
      );
      await seed.client.query('COMMIT');
    } finally {
      await end(seed);
    }
  });
});
