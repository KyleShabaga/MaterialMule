import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { migrate, type MigrateResult } from './migrator.js';
import { runSeed } from './seed.js';

export class ResetRefusedError extends Error {
  override name = 'ResetRefusedError';
}

/**
 * The only database names reset-test accepts: `materialmule_test`, optionally followed by
 * `_<suffix>` parts of lowercase letters and digits (one per worktree lane, for example
 * `materialmule_test_t07` or `materialmule_test_c3`). A name that merely contains "test"
 * (`materials_testing_prod`, `materialmule_test-prod`, `prod_materialmule_test`) is refused.
 */
export const RESETTABLE_DATABASE = /^materialmule_test(?:_[a-z0-9]+)*$/;

/**
 * reset-test drops every table, so it runs only with APP_ENV=test and only against a database
 * named by the test convention above (MM-T85, review fix #110). An `.env.test` copied with a
 * development or production URL is refused instead of wiping that database. The caller checks
 * the name of the database it is actually connected to (current_database()), not the URL.
 */
export function assertResettable(appEnv: AppConfig['APP_ENV'], database: string): void {
  if (appEnv !== 'test') {
    throw new ResetRefusedError(
      'reset-test only runs with APP_ENV=test (use --env-file .env.test).',
    );
  }
  if (!RESETTABLE_DATABASE.test(database)) {
    throw new ResetRefusedError(
      'reset-test drops every table, so it only runs against a designated test database: ' +
        'materialmule_test or materialmule_test_<suffix> (lowercase letters and digits). ' +
        'Check DATABASE_URL in the env file.',
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
