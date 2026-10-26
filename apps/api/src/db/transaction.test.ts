import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { withTransaction } from './transaction.js';

describe.runIf(testDatabaseUrl)('withTransaction', () => {
  let db: TestSchema;

  beforeAll(async () => {
    db = await createTestSchema();
    await db.pool.query('CREATE TABLE tx_probe (value text NOT NULL)');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('commits when the work succeeds', async () => {
    const result = await withTransaction(db.pool, async (client) => {
      await client.query(`INSERT INTO tx_probe VALUES ('kept')`);
      return 'done';
    });
    expect(result).toBe('done');
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM tx_probe WHERE value = 'kept'`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('rolls back everything and rethrows when the work fails', async () => {
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(`INSERT INTO tx_probe VALUES ('discarded')`);
        throw new Error('injected failure');
      }),
    ).rejects.toThrowError('injected failure');
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM tx_probe WHERE value = 'discarded'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('applies the requested isolation level', async () => {
    const level = await withTransaction(
      db.pool,
      async (client) =>
        (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
      { isolationLevel: 'serializable' },
    );
    expect(level).toBe('serializable');
  });
});
