import {
  confirmReceiptResponseSchema,
  printHistoryResponseSchema,
  printJobSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  bootReceivingHarness,
  LAB_ID,
  type ReceivingHarness,
} from '../test-support/receiving-harness.js';

// MM-T65: print history shows the receiver, the requester and the confirmer of each job as they
// were at the time (Kyle, 2026-10-27: "Yes, all three"), like unit history does since MM-T56.
// Fictional data only: DEMO-2601, Alex Tester, Pat Example.

describe.runIf(testDatabaseUrl)('print history people (MM-T65)', () => {
  let harness: ReceivingHarness;
  let printer: FakeZebraPrinter;

  beforeAll(async () => {
    printer = await FakeZebraPrinter.start();
    harness = await bootReceivingHarness({
      LABEL_PRINTER_HOST: printer.host,
      LABEL_PRINTER_PORT: String(printer.port),
    });
  });

  afterAll(async () => {
    await harness?.close();
    await printer?.stop();
  });

  it('T1/AC1: after people are renamed, re-initialled and disabled, jobs keep them as they were', async () => {
    const lab = await harness.cookieFor('lab');
    const confirmed = await harness.postReceipt(harness.receipt(1), lab);
    expect(confirmed.status).toBe(201);
    const unit = confirmReceiptResponseSchema.parse(confirmed.body).units[0]!;

    const printed = await harness
      .http()
      .post('/api/print-jobs')
      .set('Cookie', lab)
      .set(CSRF_HEADER, '1')
      .send({ storageUnitIds: [unit.storageUnitId], kind: 'initial' });
    expect(printed.status).toBe(201);
    const jobId = printJobSchema.parse(printed.body).id;
    const readJob = async () =>
      printJobSchema.parse(
        (await harness.http().get(`/api/print-jobs/${jobId}`).set('Cookie', lab)).body,
      );
    await expect.poll(async () => (await readJob()).status, { timeout: 10_000 }).toBe('sent');

    // Pat Example confirms the labels came out.
    const confirmedPrint = await harness
      .http()
      .post(`/api/print-jobs/${jobId}/confirm-physical`)
      .set('Cookie', await harness.cookieFor('pe'))
      .set(CSRF_HEADER, '1');
    expect(confirmedPrint.status).toBe(200);
    const before = await readJob();
    expect(before.physicallyConfirmedBy).toEqual({
      userId: harness.users.pe,
      initials: 'PE',
      name: 'Pat Example',
    });

    await harness.db.pool.query(
      `UPDATE app_user SET display_name = 'Renamed ' || display_name, official_initials = 'RN'
       WHERE id = ANY($1::uuid[])`,
      [[harness.users.at, harness.users.pe, LAB_ID]],
    );
    await harness.db.pool.query(
      `UPDATE app_user SET status = 'disabled', disabled_reason = 'left the company'
       WHERE id = ANY($1::uuid[])`,
      [[harness.users.at, harness.users.pe]],
    );

    const history = await harness
      .http()
      .get(`/api/storage-units/${unit.suNumber}/print-history`)
      .set('Cookie', lab);
    expect(history.status).toBe(200);
    expect(printHistoryResponseSchema.parse(history.body).jobs[0]!.receiver).toEqual({
      userId: harness.users.at,
      initials: 'AT',
      name: 'Alex Tester',
    });

    const after = await readJob();
    expect(after.receiver).toEqual({
      userId: harness.users.at,
      initials: 'AT',
      name: 'Alex Tester',
    });
    expect(after.requestedBy).toEqual(before.requestedBy);
    expect(after.requestedBy.name).not.toMatch(/Renamed/);
    expect(after.physicallyConfirmedBy).toEqual(before.physicallyConfirmedBy);

    // The snapshots are on the job row itself.
    const { rows } = await harness.db.pool.query(
      `SELECT receiver_initials_snapshot, receiver_name_snapshot, confirmed_by_initials_snapshot,
              confirmed_by_name_snapshot
       FROM print_job WHERE id = $1`,
      [jobId],
    );
    expect(rows).toEqual([
      {
        receiver_initials_snapshot: 'AT',
        receiver_name_snapshot: 'Alex Tester',
        confirmed_by_initials_snapshot: 'PE',
        confirmed_by_name_snapshot: 'Pat Example',
      },
    ]);
  });
});
