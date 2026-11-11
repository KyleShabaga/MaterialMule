import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withDatabase } from './support/db';
import { insertTestedTubeUnit } from './support/tested-tube';

// Review fix (#105): the tested-tube fixture's receipt and tube are made together, and a drawn
// ID that is already taken is drawn again instead of failing setup with an orphan receipt.
// Database only (no browser). Fictional data: DEMO-2601, TH26-01, ST-2025-NNNNNN.

const TH26_01_ID = '00000000-0000-4000-8000-000000000301';

const receiptsWith = (hash: string) =>
  withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string; units: number }>(
      `SELECT r.id, (SELECT count(*)::int FROM storage_unit su WHERE su.receipt_id = r.id) AS units
         FROM receipt r WHERE r.request_hash = $1`,
      [hash],
    );
    return rows;
  });

test('a taken ID is drawn again: one usable tube, one receipt', async () => {
  const taken = await withDatabase((client) => insertTestedTubeUnit(client, TH26_01_ID));
  const takenNumber = Number(taken.readableId.slice('ST-2025-'.length));

  const hash = `e2e-${randomUUID()}`;
  const draws = [takenNumber];
  const tube = await withDatabase((client) =>
    insertTestedTubeUnit(client, TH26_01_ID, {
      draw: () => draws.shift() ?? randomInt(1, 999_999),
      requestHash: hash,
    }),
  );
  expect(draws).toEqual([]);
  expect(tube.readableId).not.toBe(taken.readableId);
  expect(tube.readableId).toMatch(/^ST-2025-\d{6}$/);
  const receipts = await receiptsWith(hash);
  expect(receipts).toEqual([{ id: expect.any(String), units: 1 }]);
});

test('any other error is thrown and leaves no receipt behind', async () => {
  const hash = `e2e-${randomUUID()}`;
  // A hole that doesn't exist: the tube's foreign key refuses it.
  await expect(
    withDatabase((client) => insertTestedTubeUnit(client, randomUUID(), { requestHash: hash })),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await receiptsWith(hash)).toEqual([]);
});
