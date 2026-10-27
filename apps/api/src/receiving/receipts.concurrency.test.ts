import type { ConfirmReceiptResponse } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../db/transaction.js';
import {
  allocateStorageUnitIds,
  PREFIX_BY_HOLDER,
  type HolderKind,
} from '../numbering/storage-unit-id.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';

// MM-T18 card test T3 (concurrency) for receipts. Parallel corrections (version conflict) and
// parallel project / test-hole creation are already proven in corrections.integration.test.ts and
// projects.test.ts; docs/testing/receiving-critical-path.md maps them. Fictional data only.

const sequence = (id: string) => Number(id.slice(-6));

describe.runIf(testDatabaseUrl)('concurrent receipts (MM-T18 T3)', () => {
  let h: ReceivingHarness;

  beforeAll(async () => {
    h = await bootReceivingHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('parallel receipts from several stations get distinct, contiguous BKT IDs with no gaps', async () => {
    const before = await h.snapshot();
    const cookies = await Promise.all([h.cookieFor('lab'), h.cookieFor('at'), h.cookieFor('pe')]);
    // 15 receipts of 1–4 buckets each, all sent at once from three signed-in stations.
    const sizes = Array.from({ length: 15 }, (_, i) => (i % 4) + 1);
    const bodies = sizes.map((n) => h.receipt(n));
    const responses = await Promise.all(
      bodies.map((body, i) => h.postReceipt(body, cookies[i % cookies.length]!)),
    );

    expect(responses.map((r) => r.status)).toEqual(sizes.map(() => 201));
    const results = responses.map((r) => r.body as ConfirmReceiptResponse);
    const total = sizes.reduce((a, b) => a + b, 0);
    const all = results.flatMap((r) => r.units.map((u) => u.suNumber));
    expect(new Set(all).size).toBe(total);
    for (const id of all) expect(id).toMatch(/^BKT-\d{4}-\d{6}$/);
    // Each receipt holds one contiguous block, in submitted order.
    for (const [i, result] of results.entries()) {
      expect(result.units.map((u) => u.clientRowId)).toEqual(
        bodies[i]!.units.map((u) => u.clientRowId),
      );
      const numbers = result.units.map((u) => sequence(u.suNumber));
      numbers.forEach((n, k) => expect(n).toBe(numbers[0]! + k));
    }
    // Together they are exactly the next `total` numbers: no duplicates and no gaps.
    const startedAt = (before.counters as { last_value: number }[])[0]?.last_value ?? 0;
    expect(all.map(sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, i) => startedAt + i + 1),
    );
    const after = await h.snapshot();
    expect(after.receipts).toBe((before.receipts as number) + sizes.length);
    expect(after.units).toBe((before.units as number) + total);
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT readable_id FROM storage_unit
                                       GROUP BY readable_id HAVING count(*) > 1) d`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('a retry racing other receipts still gets its original IDs and no extra units', async () => {
    const cookie = await h.cookieFor('lab');
    const retried = h.receipt(2);
    const others = Array.from({ length: 6 }, () => h.receipt(1));
    const first = await h.postReceipt(retried, cookie);
    expect(first.status).toBe(201);
    const responses = await Promise.all([
      h.postReceipt(retried, cookie),
      ...others.map((body) => h.postReceipt(body, cookie)),
      h.postReceipt(retried, cookie),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 201, 201, 201, 201, 201, 201]);
    expect(responses[0]!.body).toEqual(first.body);
    expect(responses.at(-1)!.body).toEqual(first.body);
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       WHERE r.idempotency_key = $1`,
      [retried.idempotencyKey],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('simultaneous allocations for every prefix and two years keep each counter separate', async () => {
    await h.db.pool.query('DELETE FROM storage_unit_annual_counter');
    const kinds: HolderKind[] = ['bucket', 'shelby_tube', 'core_box', 'generic'];
    const years = [new Date('2026-10-25T18:00:00Z'), new Date('2027-01-03T18:00:00Z')];
    // 8 transactions of 2 IDs per prefix per year, interleaved and started together.
    const jobs = Array.from({ length: 8 }, () =>
      years.flatMap((issuedAt) => kinds.map((kind) => ({ kind, issuedAt }))),
    ).flat();
    const results = await Promise.all(
      jobs.map(({ kind, issuedAt }) =>
        withTransaction(h.db.pool, (client) =>
          allocateStorageUnitIds(client, kind, 2, {
            issuedAt,
            timeZone: 'America/Edmonton',
          }),
        ),
      ),
    );
    for (const kind of kinds) {
      for (const year of [2026, 2027]) {
        const prefix = PREFIX_BY_HOLDER[kind];
        const ids = results
          .flatMap((r) => r.ids)
          .filter((id) => id.startsWith(`${prefix}-${year}-`));
        expect(
          ids.map(sequence).sort((a, b) => a - b),
          `${prefix}-${year}`,
        ).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      }
    }
    const { rows } = await h.db.pool.query(
      'SELECT prefix, year, last_value FROM storage_unit_annual_counter ORDER BY prefix, year',
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.last_value).toBe(16);
  });
});
