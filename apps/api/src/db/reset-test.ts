import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { migrate, type MigrateResult } from './migrator.js';
import { runSeed } from './seed.js';

export class ResetRefusedError extends Error {
  override name = 'ResetRefusedError';
}

/**
 * reset-test drops every table, so it runs only with APP_ENV=test and only against a database
 * whose name contains "test" (MM-T85). An `.env.test` copied with a development URL is refused
 * instead of wiping the development database.
 */
export function assertResettable(appEnv: AppConfig['APP_ENV'], database: string): void {
  if (appEnv !== 'test') {
    throw new ResetRefusedError(
      'reset-test only runs with APP_ENV=test (use --env-file .env.test).',
    );
  }
  if (!database.toLowerCase().includes('test')) {
    throw new ResetRefusedError(
      'reset-test drops every table, so it only runs against a database whose name contains ' +
        '"test". Check DATABASE_URL in the env file.',
    );
  }
}

/** Drops and rebuilds the connected test database from the migrations, with reference data. */
export async function resetTestDatabase(
  pool: Pool,
  options: { appEnv: AppConfig['APP_ENV'] },
): Promise<MigrateResult> {
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  assertResettable(options.appEnv, rows[0]!.name);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const result = await migrate(pool);
  await runSeed(pool, 'reference', options.appEnv);
  return result;
}
