import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/policy.js';
import { listAuditForEntity } from '../audit/audit.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { enqueuePrintJob, getPrintJob } from './print-queue.js';
import { PrintWorker } from './print-worker.js';
import { ZebraTcpTransport } from './zebra-client.js';

// BUG-012: a sticker queued before its unit was disposed is never sent afterwards (MM-T77).
// Fictional data only: DEMO-2601, TH26-01, BKT-2026-0001xx.

const silent = { error: () => undefined, warn: () => undefined };
const transport = new ZebraTcpTransport({
  connectTimeoutMs: 1_000,
  statusTimeoutMs: 300,
  sendTimeoutMs: 500,
});

describe.runIf(testDatabaseUrl)('queued labels after disposal (BUG-012)', () => {
  let db: TestSchema;
  let user: AuthUser;
  let printer: FakeZebraPrinter;
  let ids: { projectId: string; receiptId: string; locationId: string; holeId: string };
  let sequence = 100;

  async function bucket(): Promise<{ id: string; readableId: string }> {
    sequence += 1;
    const readableId = `BKT-2026-${String(sequence).padStart(6, '0')}`;
    const id = await insertStorageUnit(db.pool, ids, { readableId });
    await insertSummary(
      db.pool,
      { storageUnitId: id, projectId: ids.projectId, testHoleId: ids.holeId },
      { type: 'all' },
    );
    return { id, readableId };
  }

  /** What either disposal route leaves on the unit row. */
  const dispose = (id: string) =>
    db.pool.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now(), version = version + 1
       WHERE id = $1`,
      [id],
    );

  const setEnabled = (enabled: boolean) =>
    db.pool.query(`UPDATE printer SET enabled = $1 WHERE key = 'receiving'`, [enabled]);

  async function usePrinter(port: number) {
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default, check_status)
       VALUES ('receiving', 'Receiving ZD621', '127.0.0.1', $1, true, true)
       ON CONFLICT (key) DO UPDATE SET port = EXCLUDED.port, enabled = true`,
      [port],
    );
  }

  const worker = (retryBaseMs = 0) =>
    new PrintWorker(
      db.pool,
      transport,
      { pollIntervalMs: 20, retryBaseMs, maxAttempts: 3 },
      silent,
    );

  const enqueue = (storageUnitIds: string[]) =>
    enqueuePrintJob(db.pool, user, { storageUnitIds, kind: 'reprint' }, null);

  beforeAll(async () => {
    db = await createMigratedSchema();
    const userId = await insertUser(db.pool);
    user = {
      userId,
      sessionId: 's',
      accountType: 'test',
      status: 'active',
      roles: [],
      displayName: 'Test AT',
      initials: 'AT',
    };
    const locationId = await receivingLabId(db.pool);
    const projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    const holeId = await insertTestHole(db.pool, projectId, 'TH26-01');
    const receiptId = await insertReceipt(db.pool, projectId, userId, 2);
    ids = { projectId, receiptId, locationId, holeId };
    printer = await FakeZebraPrinter.start();
    await usePrinter(printer.port);
  });

  afterEach(async () => {
    printer.jobs.length = 0;
    await usePrinter(printer.port);
    await db.pool.query(
      `UPDATE print_job SET status = 'failed' WHERE status IN ('queued', 'sending')`,
    );
  });

  afterAll(async () => {
    await printer?.stop();
    await db?.drop();
  });

  it('a job held on a turned-off printer fails unsent once its unit is disposed', async () => {
    const unit = await bucket();
    // Valid when requested: the printer is on and the unit in stock.
    const job = await enqueue([unit.id]);
    await setEnabled(false);
    await dispose(unit.id);
    await setEnabled(true);

    await worker().drain();

    expect(printer.jobs).toHaveLength(0);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: `Not printed: ${unit.readableId} was disposed after this label was requested. Nothing in this job was sent.`,
    });
    const audit = await listAuditForEntity(db.pool, 'print_job', job.id);
    expect(audit[0]).toMatchObject({ action: 'label.print_failed' });
    // Print history keeps the request.
    const { rows } = await db.pool.query('SELECT 1 FROM print_job_item WHERE print_job_id = $1', [
      job.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('a job waiting for a retry after a safe failure fails unsent once its unit is disposed', async () => {
    const unit = await bucket();
    await usePrinter(await FakeZebraPrinter.unusedPort());
    const job = await enqueue([unit.id]);
    // One attempt only: a long retry delay keeps the job queued after it.
    await worker(60_000).drain();
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    await dispose(unit.id);
    await usePrinter(printer.port);
    await db.pool.query('UPDATE print_job SET next_attempt_at = now() WHERE id = $1', [job.id]);

    await worker().drain();

    expect(printer.jobs).toHaveLength(0);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('a mixed job prints nothing, names only the disposed unit, and the live unit reprints', async () => {
    const live = await bucket();
    const gone = await bucket();
    const job = await enqueue([live.id, gone.id]);
    await setEnabled(false);
    await dispose(gone.id);
    await setEnabled(true);

    await worker().drain();

    expect(printer.jobs).toHaveLength(0);
    const failed = await getPrintJob(db.pool, job.id);
    expect(failed).toMatchObject({ status: 'failed', sentAt: null });
    expect(failed!.lastError).toContain(gone.readableId);
    expect(failed!.lastError).not.toContain(live.readableId);

    const again = await enqueue([live.id]);
    await worker().drain();
    expect(await getPrintJob(db.pool, again.id)).toMatchObject({ status: 'sent' });
    expect(printer.labels.join('')).toContain(live.readableId);
  });

  it('a claim racing a disposal waits for it and then sends nothing', async () => {
    const unit = await bucket();
    const job = await enqueue([unit.id]);
    // A disposal in progress: the unit is locked FOR UPDATE and marked disposed, not committed.
    const disposal = await db.pool.connect();
    const probe = await db.pool.connect();
    try {
      await disposal.query('BEGIN');
      await disposal.query('SELECT 1 FROM storage_unit WHERE id = $1 FOR UPDATE', [unit.id]);
      await disposal.query(
        `UPDATE storage_unit SET status = 'disposed', disposed_at = now() WHERE id = $1`,
        [unit.id],
      );
      const { rows: pid } = await disposal.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const draining = worker().drain();
      // The claim's share lock waits on the disposal.
      await vi.waitFor(
        async () => {
          const { rows } = await probe.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid[0]!.pid],
          );
          expect(rows[0]!.n).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(printer.jobs).toHaveLength(0);
      await disposal.query('COMMIT');
      await draining;
    } finally {
      await disposal.query('ROLLBACK').catch(() => undefined);
      disposal.release();
      probe.release();
    }
    expect(printer.jobs).toHaveLength(0);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'failed' });
  });
});
