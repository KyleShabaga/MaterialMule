import type { ConfirmReceiptResponse, PrintJob } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import { ReceivingHarness } from '../test-support/receiving-harness.js';

// MM-T18 cross-card regression (D03, D46; MM-T13 + T14 AC5 + T15 AC5): after a personal user
// corrects a unit's received date, a reprint carries the corrected date and the same permanent
// storage unit ID, and neither the correction nor the reprint moves the unit or adds one.
// Fictional data only.

describe.runIf(testDatabaseUrl)('reprint after a correction (MM-T18)', () => {
  let printer: FakeZebraPrinter;
  let h: ReceivingHarness;

  beforeAll(async () => {
    printer = await FakeZebraPrinter.start();
    h = await ReceivingHarness.boot({
      LABEL_PRINTER_HOST: '127.0.0.1',
      LABEL_PRINTER_PORT: String(printer.port),
    });
  });

  afterAll(async () => {
    await h?.close();
    await printer?.stop();
  });

  it('prints the corrected received date with the same ID; location and unit count unchanged', async () => {
    const cookie = await h.cookieFor('at');
    const confirmed = await h.postReceipt(h.receipt(1, { receivedDate: '2026-01-15' }), cookie);
    expect(confirmed.status).toBe(201);
    const [unit] = (confirmed.body as ConfirmReceiptResponse).units;

    const print = async (kind: 'initial' | 'reprint') => {
      const queued = await h
        .http()
        .post('/api/print-jobs')
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .send({ storageUnitIds: [unit!.storageUnitId], kind });
      expect(queued.status).toBe(201);
      const id = (queued.body as PrintJob).id;
      await expect
        .poll(
          async () =>
            ((await h.http().get(`/api/print-jobs/${id}`).set('Cookie', cookie)).body as PrintJob)
              .status,
          { timeout: 10_000 },
        )
        .toBe('sent');
      return printer.labels.at(-1)!;
    };

    const original = await print('initial');
    expect(original).toContain(unit!.suNumber);
    expect(original).toContain('2026-01-15');

    const state = async () =>
      (
        await h.db.pool.query(
          `SELECT readable_id, current_location_id, receipt_id, version, received_date::text
           FROM storage_unit WHERE id = $1`,
          [unit!.storageUnitId],
        )
      ).rows[0] as Record<string, unknown>;
    const before = await state();
    const corrected = await h
      .http()
      .patch(`/api/storage-units/${unit!.storageUnitId}`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send({
        version: before.version,
        reason: 'wrong date on tag',
        changes: { receivedDate: '2026-01-12' },
      });
    expect(corrected.status).toBe(200);

    const reprinted = await print('reprint');
    expect(reprinted).toContain(unit!.suNumber);
    expect(reprinted).toContain('2026-01-12');
    expect(reprinted).not.toContain('2026-01-15');
    expect(await state()).toMatchObject({
      readable_id: before.readable_id,
      current_location_id: before.current_location_id,
      receipt_id: before.receipt_id,
      received_date: '2026-01-12',
    });
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM storage_unit',
    );
    expect(rows[0]!.n).toBe(1);
  });
});
