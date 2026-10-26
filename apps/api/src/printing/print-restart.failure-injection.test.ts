import type { ConfirmReceiptResponse, PrintJob } from '@trapezoid/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/policy.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import { LAB_ID, ReceivingHarness } from '../test-support/receiving-harness.js';
import { enqueuePrintJob } from './print-queue.js';

// TRP-T18 card test T4: the API process dies while the print worker is sending labels, then
// starts again. print-worker.test.ts proves the worker's recovery rule on its own; this runs the
// whole service boot path (PrintWorkerService) and the HTTP API around it: the interrupted job
// becomes "uncertain" and is never resent by itself, later jobs still print, a person's reprint
// goes through, and no storage unit, ID, receipt or location changes. Fictional data only.

describe.runIf(testDatabaseUrl)('worker restart during printing (TRP-T18 T4)', () => {
  let printer: FakeZebraPrinter;
  let h: ReceivingHarness;
  let cookie: string;
  let units: { id: string; readableId: string }[];

  const getJob = async (id: string) =>
    (await h.http().get(`/api/print-jobs/${id}`).set('Cookie', cookie)).body as PrintJob;

  const print = (storageUnitIds: string[], kind: 'initial' | 'reprint') =>
    h
      .http()
      .post('/api/print-jobs')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send({ storageUnitIds, kind });

  async function inventory() {
    const { rows } = await h.db.pool.query(
      `SELECT su.id, su.readable_id, su.receipt_id, su.current_location_id, su.status, su.version,
              su.project_id, su.received_date
       FROM storage_unit su ORDER BY su.readable_id`,
    );
    const counts = await h.db.pool.query(
      `SELECT (SELECT count(*) FROM storage_unit)::int AS units,
              (SELECT count(*) FROM receipt)::int AS receipts`,
    );
    return { rows, counts: counts.rows[0] };
  }

  beforeAll(async () => {
    printer = await FakeZebraPrinter.start();
    h = await ReceivingHarness.boot({
      LABEL_PRINTER_HOST: '127.0.0.1',
      LABEL_PRINTER_PORT: String(printer.port),
    });
    cookie = await h.cookieFor('lab');
    const confirmed = await h.postReceipt(h.receipt(2), cookie);
    expect(confirmed.status).toBe(201);
    units = (confirmed.body as ConfirmReceiptResponse).units.map((u) => ({
      id: u.storageUnitId,
      readableId: u.suNumber,
    }));
  });

  afterAll(async () => {
    await h?.close();
    await printer?.stop();
  });

  it('an interrupted job becomes uncertain on restart; later jobs and a reprint still work', async () => {
    const first = await print(
      units.map((u) => u.id),
      'initial',
    );
    expect(first.status).toBe(201);
    await expect
      .poll(async () => (await getJob((first.body as PrintJob).id)).status, { timeout: 10_000 })
      .toBe('sent');
    const before = await inventory();

    // The process dies: what it leaves behind is a job marked "sending" whose bytes may or may
    // not have reached the printer, and a job queued behind it.
    await h.stop();
    const lab: AuthUser = {
      userId: LAB_ID,
      sessionId: 'crashed-process',
      accountType: 'shared_lab',
      status: 'active',
      roles: [],
      displayName: 'LAB',
      initials: null,
    };
    const interrupted = await enqueuePrintJob(
      h.db.pool,
      lab,
      { storageUnitIds: [units[0]!.id], kind: 'reprint' },
      null,
    );
    await h.db.pool.query(`UPDATE print_job SET status = 'sending', attempts = 1 WHERE id = $1`, [
      interrupted.id,
    ]);
    const later = await enqueuePrintJob(
      h.db.pool,
      lab,
      { storageUnitIds: [units[1]!.id], kind: 'reprint' },
      null,
    );
    const labelsBefore = printer.labels.length;

    await h.start();
    await expect
      .poll(async () => (await getJob(later.id)).status, { timeout: 10_000 })
      .toBe('sent');
    expect(await getJob(interrupted.id)).toMatchObject({
      status: 'uncertain',
      lastError: 'Trapezoid restarted while sending these labels',
    });
    // Only the later job reached the printer; the interrupted one waits for a person.
    expect(printer.labels.slice(labelsBefore)).toHaveLength(1);
    expect(printer.labels.at(-1)).toContain(units[1]!.readableId);

    // The person checks the printer and reprints: same storage unit ID, nothing else changes.
    const reprint = await print([units[0]!.id], 'reprint');
    expect(reprint.status).toBe(201);
    await expect
      .poll(async () => (await getJob((reprint.body as PrintJob).id)).status, { timeout: 10_000 })
      .toBe('sent');
    expect(printer.labels.at(-1)).toContain(units[0]!.readableId);
    expect(await inventory()).toEqual(before);
  });
});
