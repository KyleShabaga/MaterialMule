import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { RebuildRefusedError, rebuildDisposableDatabase } from './rebuild.js';

// MM-AO02: rebuild-dev refuses unless it runs in development against the database it was told is
// disposable. Only the refusals are exercised here: a rebuild drops the shared test database's
// public schema, so the success path is proven by hand on a disposable database (docs/database.md).
describe.runIf(testDatabaseUrl)('rebuild-dev guard (MM-AO02)', () => {
  let db: TestSchema;
  let database: string;

  beforeAll(async () => {
    db = await createTestSchema();
    database = (await db.pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!
      .name;
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('refuses outside development, even when the database is named', async () => {
    for (const appEnv of ['test', 'production'] as const) {
      await expect(
        rebuildDisposableDatabase(db.pool, { appEnv, designated: database }),
      ).rejects.toBeInstanceOf(RebuildRefusedError);
    }
  });

  it('refuses in development unless the connected database is named exactly', async () => {
    for (const designated of [undefined, '', `${database}_other`, database.toUpperCase()]) {
      if (designated === database) continue;
      await expect(
        rebuildDisposableDatabase(db.pool, { appEnv: 'development', designated }),
      ).rejects.toBeInstanceOf(RebuildRefusedError);
    }
    // Nothing was dropped: this test's own schema is still there.
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS schemas FROM pg_namespace WHERE nspname = $1`,
      [db.schema],
    );
    expect(rows[0]).toEqual({ schemas: 1 });
  });
});
