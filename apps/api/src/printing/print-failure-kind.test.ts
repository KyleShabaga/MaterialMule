import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/policy.js';
import { listAuditForEntity } from '../audit/audit.js';
import { defaultPrinterSummary } from '../system-status/system-status.js';
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
import { enqueuePrintJob, getPrintJob } from './print-queue.js';
import { PrintWorker } from './print-worker.js';
import type { PrinterTarget, PrinterTransport, SendOutcome } from './zebra-client.js';

// MTR-45 review fix: a job refused before the printer is contacted must not be reported as the
// printer not responding. The worker records a structured failure kind on label.print_failed,
// and System status reads it. Fictional data only: DEMO-2601, TH26-01, BKT-2026-0002xx.

/** Records every send and answers with whatever the test sets. No network. */
class RecordingTransport implements PrinterTransport {
  readonly calls: PrinterTarget[] = [];
  next: SendOutcome = { result: 'sent' };

  send(target: PrinterTarget): Promise<SendOutcome> {
    this.calls.push(target);
    return Promise.resolve(this.next);
  }
}

const silent = { error: () => undefined, warn: () => undefined };

describe.runIf(testDatabaseUrl)('print failure kinds (MTR-45)', () => {
  let db: TestSchema;
  let user: AuthUser;
  let transport: RecordingTransport;
  let ids: { projectId: string; receiptId: string; locationId: string; holeId: string };
  let sequence = 200;

  async function bucket(): Promise<string> {
    sequence += 1;
    const readableId = `BKT-2026-${String(sequence).padStart(6, '0')}`;
    const id = await insertStorageUnit(db.pool, ids, { readableId });
    await insertSummary(
      db.pool,
      { storageUnitId: id, projectId: ids.projectId, testHoleId: ids.holeId },
      { type: 'all' },
    );
    return id;
  }

  /** What either disposal route leaves on the unit row. */
  const dispose = (id: string) =>
    db.pool.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now(), version = version + 1
       WHERE id = $1`,
      [id],
    );

  /** An unknown template version makes rendering throw. */
  const breakTemplate = (jobId: string) =>
    db.pool.query(`UPDATE print_job SET template_version = 'v999' WHERE id = $1`, [jobId]);

  const worker = () =>
    new PrintWorker(
      db.pool,
      transport,
      { pollIntervalMs: 20, retryBaseMs: 0, maxAttempts: 3 },
      silent,
    );

  const enqueue = (storageUnitIds: string[]) =>
    enqueuePrintJob(db.pool, user, { storageUnitIds, kind: 'reprint' }, null);

  async function failureKindOf(jobId: string): Promise<unknown> {
    const events = await listAuditForEntity(db.pool, 'print_job', jobId);
    const failed = events.filter((event) => event.action === 'label.print_failed');
    expect(failed).toHaveLength(1);
    return (failed[0]!.after as { failure?: unknown } | null)?.failure;
  }

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
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default, check_status)
       VALUES ('receiving', 'Receiving ZD621', '127.0.0.1', 9193, true, false)`,
    );
  });

  beforeEach(async () => {
    transport = new RecordingTransport();
    await db.pool.query('DELETE FROM print_job_item');
    await db.pool.query('DELETE FROM print_job');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a unit disposed after enqueueing fails the job without contacting the printer', async () => {
    const unit = await bucket();
    const job = await enqueue([unit]);
    await dispose(unit);
    await worker().drain();

    expect(transport.calls).toHaveLength(0);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'failed' });
    expect(await failureKindOf(job.id)).toBe('unit_disposed');

    const summary = await defaultPrinterSummary(db.pool);
    // Nothing reached the printer: no attempt, so neither "not responding" nor "OK".
    expect(summary!.lastAttempt).toBeNull();
    expect(summary!.failingSince).toBeNull();
    expect(summary!.lastJobFailure).toMatchObject({
      kind: 'unit_disposed',
      error: expect.stringContaining('was disposed after this label was requested'),
    });
  });

  it('a label that cannot be prepared fails without contacting the printer', async () => {
    const job = await enqueue([await bucket()]);
    await breakTemplate(job.id);
    await worker().drain();

    expect(transport.calls).toHaveLength(0);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({
      status: 'failed',
      lastError: 'The label could not be prepared',
    });
    expect(await failureKindOf(job.id)).toBe('label_preparation');
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toBeNull();
    expect(summary!.lastJobFailure).toMatchObject({ kind: 'label_preparation' });
  });

  it('a printer that refuses every attempt fails as a printer failure', async () => {
    transport.next = {
      result: 'not_sent',
      error: 'Printer refused the connection',
      printerMessage: null,
    };
    const job = await enqueue([await bucket()]);
    await worker().drain();

    expect(transport.calls).toHaveLength(3);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await failureKindOf(job.id)).toBe('printer');
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({
      outcome: 'failed',
      error: 'Printer refused the connection',
    });
    expect(summary!.failingSince).not.toBeNull();
    expect(summary!.lastJobFailure).toBeNull();
  });

  it('a refused job after a good print keeps the printer OK and reports the job separately', async () => {
    await enqueue([await bucket()]);
    await worker().drain();
    expect(transport.calls).toHaveLength(1);

    const later = await enqueue([await bucket()]);
    await breakTemplate(later.id);
    await worker().drain();
    expect(transport.calls).toHaveLength(1);

    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({ outcome: 'ok' });
    expect(summary!.lastJobFailure).toMatchObject({ kind: 'label_preparation' });
  });

  it('a refused job after a printer failure leaves the printer reported as not responding', async () => {
    transport.next = { result: 'not_sent', error: "Printer didn't respond", printerMessage: null };
    await enqueue([await bucket()]);
    await worker().drain();

    const unit = await bucket();
    await enqueue([unit]);
    await dispose(unit);
    await worker().drain();
    expect(transport.calls).toHaveLength(3);

    const summary = await defaultPrinterSummary(db.pool);
    // The newer refused job neither hides the printer failure nor stands in for it.
    expect(summary!.lastAttempt).toMatchObject({
      outcome: 'failed',
      error: "Printer didn't respond",
    });
    expect(summary!.lastJobFailure).toMatchObject({ kind: 'unit_disposed' });
  });

  it('an uncertain delivery stays uncertain and is not a job failure', async () => {
    transport.next = { result: 'uncertain', error: 'Connection dropped while sending' };
    const job = await enqueue([await bucket()]);
    await worker().drain();

    expect(transport.calls).toHaveLength(1);
    expect(await getPrintJob(db.pool, job.id)).toMatchObject({ status: 'uncertain' });
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({ outcome: 'uncertain' });
    expect(summary!.lastJobFailure).toBeNull();
  });
});
