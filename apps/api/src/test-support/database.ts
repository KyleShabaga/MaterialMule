import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate, type MigrationFile } from '../db/migrator.js';

/** TEST_DATABASE_URL, or undefined when database tests can't run on this machine. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl && process.env.REQUIRE_DATABASE_TESTS === '1') {
  throw new Error('REQUIRE_DATABASE_TESTS=1 but TEST_DATABASE_URL is not set.');
}

export interface TestSchema {
  pool: Pool;
  schema: string;
  drop(): Promise<void>;
}

/**
 * Creates an empty, uniquely named schema in the test database and a pool whose search_path
 * points at it, so each test file gets an isolated copy of the tables.
 */
export async function createTestSchema(): Promise<TestSchema> {
  if (!testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is not set.');
  }
  const schema = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 5,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      const cleanup = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}

/** A DATABASE_URL whose connections use `schema`, for booting the whole app against it. */
export function databaseUrlForSchema(schema: string): string {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/** A fresh schema with every migration applied. */
export async function createMigratedSchema(migrations?: MigrationFile[]): Promise<TestSchema> {
  const testSchema = await createTestSchema();
  await migrate(testSchema.pool, migrations);
  return testSchema;
}
