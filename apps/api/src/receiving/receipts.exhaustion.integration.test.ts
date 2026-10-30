import type { ConfirmReceiptResponse } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issuanceYear } from '../numbering/storage-unit-id.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';

// BUG-008: a full prefix/year counter gives a clear 409 and changes nothing; the numbering format
// and limit (999999 per prefix and year) are unchanged. Fictional data only: DEMO-2601, TH26-01.
describe.runIf(testDatabaseUrl)('receipts when the ID counter is full (BUG-008)', () => {
  let h: ReceivingHarness;
  let cookie: string;
  let year: number;

  const tube = (clientRowId: string) => ({
    clientRowId,
    unitType: 'shelby_tube' as const,
    sample: { sourceType: 'test_hole' as const, testHoleId: h.holes.th01, sampleReference: 'T1' },
  });
  const counter = async (prefix: string) => {
    const { rows } = await h.db.pool.query<{ last_value: number }>(
      'SELECT last_value FROM storage_unit_annual_counter WHERE prefix = $1 AND year = $2',
      [prefix, year],
    );
    return rows[0]?.last_value;
  };

  beforeAll(async () => {
    // Its own schema: counters can only go up (MM-T47).
    h = await bootReceivingHarness();
    cookie = await h.cookieFor('at');
    year = issuanceYear(new Date(), 'America/Edmonton');
    await h.db.pool.query(
      `INSERT INTO storage_unit_annual_counter (prefix, year, last_value)
       VALUES ('BKT', $1, 999998), ('ST', $1, 999998)`,
      [year],
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it('issues the last ID, then refuses the next receipt with 409 and saves nothing', async () => {
    const last = await h.postReceipt(h.receipt(1), cookie);
    expect(last.status, JSON.stringify(last.body)).toBe(201);
    expect((last.body as ConfirmReceiptResponse).units[0]!.suNumber).toBe(`BKT-${year}-999999`);

    const before = await h.snapshot();
    const refused = await h.postReceipt(h.receipt(1), cookie);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'storage_unit_ids_exhausted',
      prefix: 'BKT',
      year,
      message: expect.stringContaining(`No BKT- storage unit IDs are left for ${year}`),
    });
    expect(await h.snapshot()).toEqual(before);
    expect(await counter('BKT')).toBe(999999);
  });

  it('refuses a batch that would cross the limit without using a number, then the last one fits', async () => {
    const before = await h.snapshot();
    const crossing = await h.postReceipt(h.receipt(0, { units: [tube('t1'), tube('t2')] }), cookie);
    expect(crossing.status).toBe(409);
    expect(crossing.body).toMatchObject({ code: 'storage_unit_ids_exhausted', prefix: 'ST' });
    expect(await h.snapshot()).toEqual(before);
    expect(await counter('ST')).toBe(999998);

    const fits = await h.postReceipt(h.receipt(0, { units: [tube('t1')] }), cookie);
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect((fits.body as ConfirmReceiptResponse).units[0]!.suNumber).toBe(`ST-${year}-999999`);
  });
});
