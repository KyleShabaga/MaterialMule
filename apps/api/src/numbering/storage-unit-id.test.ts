import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../db/transaction.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  StorageUnitIdOverflowError,
  allocateStorageUnitIds,
  formatStorageUnitId,
  issuanceYear,
  type HolderKind,
} from './storage-unit-id.js';

const EDMONTON = 'America/Edmonton';

describe('formatStorageUnitId', () => {
  it('pads the sequence to six digits', () => {
    expect(formatStorageUnitId('BKT', 2026, 1)).toBe('BKT-2026-000001');
    expect(formatStorageUnitId('CT', 2026, 1)).toBe('CT-2026-000001');
    expect(formatStorageUnitId('ST', 2027, 999_999)).toBe('ST-2027-999999');
  });

  it('rejects sequences outside 1–999999', () => {
    expect(() => formatStorageUnitId('BKT', 2026, 0)).toThrowError(RangeError);
    expect(() => formatStorageUnitId('BKT', 2026, 1_000_000)).toThrowError(RangeError);
  });
});

describe('issuanceYear', () => {
  it('uses the business time zone, not UTC', () => {
    // Edmonton is UTC−6 or UTC−7 depending on the tzdata release (2026c has Alberta on MDT all
    // year), so these instants are chosen to fall on the same local side under either offset.
    // 05:30 UTC → 22:30/23:30 on Dec 31; 07:30 UTC → 00:30/01:30 on Jan 1.
    expect(issuanceYear(new Date('2027-01-01T05:30:00Z'), EDMONTON)).toBe(2026);
    expect(issuanceYear(new Date('2027-01-01T07:30:00Z'), EDMONTON)).toBe(2027);
    // Plain UTC would already say 2027 for the first instant.
    expect(issuanceYear(new Date('2027-01-01T05:30:00Z'), 'UTC')).toBe(2027);
  });
});

describe.runIf(testDatabaseUrl)('allocateStorageUnitIds', () => {
  let db: TestSchema;

  // Counters can never be deleted or lowered (MM-T47), so each test starts from its own schema.
  beforeEach(async () => {
    db = await createMigratedSchema();
  });

  afterEach(async () => {
    await db?.drop();
  });

  const allocate = (holder: HolderKind, count: number, issuedAt: Date) =>
    withTransaction(db.pool, (client) =>
      allocateStorageUnitIds(client, holder, count, { issuedAt, timeZone: EDMONTON }),
    );

  it('AC1: 20 concurrent receipts of 3 get 60 distinct IDs, contiguous per receipt', async () => {
    const issuedAt = new Date('2026-10-25T18:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => allocate('bucket', 3, issuedAt)),
    );

    const all = results.flatMap((r) => r.ids);
    expect(new Set(all).size).toBe(60);
    for (const result of results) {
      const numbers = result.ids.map((id) => Number(id.slice(-6)));
      expect(numbers[1]! - numbers[0]!).toBe(1);
      expect(numbers[2]! - numbers[1]!).toBe(1);
    }
    expect(all.map((id) => Number(id.slice(-6))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
  });

  it('AC2: a rolled-back allocation consumes no committed number', async () => {
    const issuedAt = new Date('2026-10-25T18:00:00Z');
    const committed = await allocate('bucket', 2, issuedAt);
    await expect(
      withTransaction(db.pool, async (client) => {
        await allocateStorageUnitIds(client, 'bucket', 5, { issuedAt, timeZone: EDMONTON });
        throw new Error('receipt failed');
      }),
    ).rejects.toThrowError('receipt failed');
    const next = await allocate('bucket', 1, issuedAt);

    expect(committed.ids).toEqual(['BKT-2026-000001', 'BKT-2026-000002']);
    expect(next.ids).toEqual(['BKT-2026-000003']);
  });

  it('AC3: rolls over to 000001 at midnight Edmonton time on January 1', async () => {
    // Late on Dec 31 and early on Jan 1 in Edmonton under either UTC offset (see issuanceYear test).
    const lastMinute = await allocate('bucket', 1, new Date('2027-01-01T05:30:00Z'));
    const firstMinute = await allocate('bucket', 1, new Date('2027-01-01T07:30:00Z'));
    expect(lastMinute.ids).toEqual(['BKT-2026-000001']);
    expect(firstMinute.ids).toEqual(['BKT-2027-000001']);
  });

  it('AC4: a receipt dated 2026-12-20 confirmed on 2027-01-03 gets a 2027 ID', async () => {
    // Only the confirmation instant is an input; the received date can't influence the year.
    const result = await allocate('bucket', 1, new Date('2027-01-03T16:00:00Z'));
    expect(result.ids[0]).toMatch(/^BKT-2027-/);
  });

  it('AC5: overflow past 999999 raises a typed error and commits nothing', async () => {
    await db.pool.query(
      `INSERT INTO storage_unit_annual_counter (prefix, year, last_value) VALUES ('BKT', 2026, 999999)`,
    );
    await expect(allocate('bucket', 1, new Date('2026-10-25T18:00:00Z'))).rejects.toBeInstanceOf(
      StorageUnitIdOverflowError,
    );
    const { rows } = await db.pool.query(
      `SELECT last_value FROM storage_unit_annual_counter WHERE prefix = 'BKT' AND year = 2026`,
    );
    expect(rows[0]).toEqual({ last_value: 999999 });
  });

  it('BUG-008: another CHECK on the counter (a year before 2000) is not reported as exhaustion', async () => {
    const failure = allocate('bucket', 1, new Date('1999-06-01T18:00:00Z'));
    await expect(failure).rejects.not.toBeInstanceOf(StorageUnitIdOverflowError);
    await expect(failure).rejects.toMatchObject({
      code: '23514',
      constraint: 'storage_unit_annual_counter_year_check',
    });
  });

  it('AC8: each prefix has its own counter', async () => {
    const issuedAt = new Date('2026-10-25T18:00:00Z');
    const first = await Promise.all(
      (['bucket', 'shelby_tube', 'core_box', 'generic'] as const).map((holder) =>
        allocate(holder, 1, issuedAt),
      ),
    );
    expect(first.map((r) => r.ids[0])).toEqual([
      'BKT-2026-000001',
      'ST-2026-000001',
      'CRE-2026-000001',
      'CT-2026-000001',
    ]);
    expect((await allocate('bucket', 1, issuedAt)).ids).toEqual(['BKT-2026-000002']);
  });

  it('AC8: rejects an unsupported holder kind and a non-positive count', async () => {
    const issuedAt = new Date('2026-10-25T18:00:00Z');
    await expect(allocate('crate' as HolderKind, 1, issuedAt)).rejects.toBeInstanceOf(TypeError);
    await expect(allocate('bucket', 0, issuedAt)).rejects.toBeInstanceOf(RangeError);
  });
});
