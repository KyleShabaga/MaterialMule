import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

const silent = { error: () => undefined, warn: () => undefined };
const transport = new ZebraTcpTransport({
  connectTimeoutMs: 1_000,
  statusTimeoutMs: 300,
  sendTimeoutMs: 500,
});

describe.runIf(testDatabaseUrl)('print worker (TRP-T15)', () => {
  let db: TestSchema;
  let user: AuthUser;
  let units: string[];
  let printer: FakeZebraPrinter;

  /** Storage unit, receipt and location rows that printing must never change. */
  async function inventorySnapshot() {
    const { rows } = await db.pool.query(
      `SELECT su.*, r.confirmed_at, r.quantity, l.code
       FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       JOIN location l ON l.id = su.current_location_id
       ORDER BY su.readable_id`,
    );
    const counts = await db.pool.query(
      'SELECT (SELECT count(*) FROM storage_unit) AS units, (SELECT count(*) FROM receipt) AS receipts',
    );
    return { rows, counts: counts.rows[0] };
  }

  async function usePrinter(port: number, checkStatus = true) {
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default, check_status)
       VALUES ('receiving', 'Receiving ZD621', '127.0.0.1', $1, true, $2)
       ON CONFLICT (key) DO UPDATE SET port = EXCLUDED.port, check_status = EXCLUDED.check_status`,
      [port, checkStatus],
    );
  }

  function worker(retryBaseMs = 0) {
    return new PrintWorker(
      db.pool,
      transport,
      { pollIntervalMs: 20, retryBaseMs, maxAttempts: 3 },
      silent,
    );
  }

  const enqueue = (storageUnitIds: string[], kind: 'initial' | 'reprint' = 'initial') =>
    enqueuePrintJob(db.pool, user, { storageUnitIds, kind }, null);

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
    const th1 = await insertTestHole(db.pool, projectId, 'TH26-01');
    const th2 = await insertTestHole(db.pool, projectId, 'TH26-02');
    const receiptId = await insertReceipt(db.pool, projectId, userId, 2);
    units = [];
    for (const readableId of ['BKT-2026-000014', 'BKT-2026-000015']) {
      const id = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        { readableId },
      );
      await insertSummary(
        db.pool,
        { storageUnitId: id, projectId, testHoleId: th1 },
        { type: 'all' },
      );
      await insertSummary(
        db.pool,
        { storageUnitId: id, projectId, testHoleId: th2 },
        { type: 'all' },
      );
      units.push(id);
    }
    printer = await FakeZebraPrinter.start();
    await usePrinter(printer.port);
  });

  afterEach(async () => {
    printer.mode = 'accept';
    printer.status = {};
    printer.jobs.length = 0;
    await usePrinter(printer.port);
    // Leave no job pending for the next test.
    await db.pool.query(
      `UPDATE print_job SET status = 'failed' WHERE status IN ('queued', 'sending')`,
    );
  });

  afterAll(async () => {
    await printer?.stop();
    await db?.drop();
  });

  it('AC1: one job for a two-unit receipt reaches sent and both labels print in order', async () => {
    const job = await enqueue(units);
    expect(job.status).toBe('queued');
    expect(job.items.map((i) => i.readableId)).toEqual(['BKT-2026-000014', 'BKT-2026-000015']);

    await worker().drain();

    const done = await getPrintJob(db.pool, job.id);
    expect(done).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
    expect(done!.sentAt).not.toBeNull();
    expect(done!.physicallyConfirmedAt).toBeNull();
    expect(printer.jobs).toHaveLength(1);
    const labels = printer.labels;
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('BKT-2026-000014');
    expect(labels[1]).toContain('BKT-2026-000015');
    expect(labels[0]).toContain('DEMO-2601');
    expect(labels[0]).toContain('TH26-01, TH26-02');
  });

  it('AC2: printer off → failed after 3 attempts; receipt, units and locations unchanged', async () => {
    const before = await inventorySnapshot();
    await usePrinter(await FakeZebraPrinter.unusedPort());
    const job = await enqueue(units);

    await worker(0).drain();

    const done = await getPrintJob(db.pool, job.id);
    expect(done).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'Printer refused the connection',
    });
    expect(await inventorySnapshot()).toEqual(before);
    const audit = await listAuditForEntity(db.pool, 'print_job', job.id);
    expect(audit.map((e) => e.action)).toEqual(['label.print_failed', 'label.print_requested']);
  });

  it('waits for the retry delay between attempts and keeps later jobs behind it', async () => {
    await usePrinter(await FakeZebraPrinter.unusedPort());
    const first = await enqueue([units[0]!]);
    const second = await enqueue([units[1]!]);

    await worker(60_000).drain();

    expect(await getPrintJob(db.pool, first.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'Printer refused the connection',
    });
    // Order is kept: the second job doesn't jump ahead while the first waits to retry.
    expect(await getPrintJob(db.pool, second.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('hang → failed; paper out → failed with the printer message', async () => {
    printer.mode = 'hang';
    const hung = await enqueue([units[0]!]);
    await worker(0).drain();
    expect(await getPrintJob(db.pool, hung.id)).toMatchObject({ status: 'failed', attempts: 3 });

    printer.mode = 'accept';
    printer.status = { paperOut: true };
    const paperOut = await enqueue([units[0]!]);
    await worker(0).drain();
    expect(await getPrintJob(db.pool, paperOut.id)).toMatchObject({
      status: 'failed',
      printerMessage: 'Printer out of labels',
    });
    expect(printer.jobs).toEqual([]);
  });

  it('AC3: a connection dropped mid-write → uncertain and never resent automatically', async () => {
    printer.mode = 'drop';
    printer.dropAfterBytes = 100;
    const job = await enqueue(units);

    const w = worker(0);
    await w.drain();
    await w.drain();

    const done = await getPrintJob(db.pool, job.id);
    expect(done).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(printer.jobs).toHaveLength(1);
    const audit = await listAuditForEntity(db.pool, 'print_job', job.id);
    expect(audit[0]!.action).toBe('label.print_uncertain');
  });

  it('AC4: a job left sending by a restart becomes uncertain and later jobs still run', async () => {
    const interrupted = await enqueue([units[0]!]);
    await db.pool.query(`UPDATE print_job SET status = 'sending', attempts = 1 WHERE id = $1`, [
      interrupted.id,
    ]);
    const later = await enqueue([units[1]!]);

    // A fresh worker is what the service starts on boot.
    const w = worker();
    w.start();
    await expect
      .poll(async () => (await getPrintJob(db.pool, later.id))?.status, { timeout: 5_000 })
      .toBe('sent');
    await w.stop();

    expect(await getPrintJob(db.pool, interrupted.id)).toMatchObject({
      status: 'uncertain',
      lastError: 'Trapezoid restarted while sending these labels',
    });
    // The interrupted job was not resent; only the later job reached the printer.
    expect(printer.labels).toHaveLength(1);
    expect(printer.labels[0]).toContain('BKT-2026-000015');
    const audit = await listAuditForEntity(db.pool, 'print_job', interrupted.id);
    expect(audit[0]).toMatchObject({ action: 'label.print_uncertain', actorAccountType: 'system' });
  });

  it('skips a turned-off printer until it is turned back on', async () => {
    // Jobs can only be queued for enabled printers, so queue first, then turn it off.
    const job = await enqueue([units[0]!]);
    await db.pool.query(`UPDATE printer SET enabled = false WHERE key = 'receiving'`);
    await worker().drain();
    expect((await getPrintJob(db.pool, job.id))!.status).toBe('queued');
    await db.pool.query(`UPDATE printer SET enabled = true WHERE key = 'receiving'`);
    await worker().drain();
    expect((await getPrintJob(db.pool, job.id))!.status).toBe('sent');
  });
});
