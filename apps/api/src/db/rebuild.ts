import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { migrate, type MigrateResult } from './migrator.js';
import { runSeed } from './seed.js';

export class RebuildRefusedError extends Error {
  override name = 'RebuildRefusedError';
}

/**
 * Drops and rebuilds a development database from the migrations, then loads the reference data
 * and the fictional development fixtures (MM-AO02). Destructive, so it runs only with
 * APP_ENV=development and only when the caller names the connected database explicitly
 * (`--disposable <database>`): a database is never assumed to be disposable. Export anything worth
 * keeping first; nothing is carried over.
 */
export async function rebuildDisposableDatabase(
  pool: Pool,
  options: { appEnv: AppConfig['APP_ENV']; designated: string | undefined },
): Promise<MigrateResult> {
  if (options.appEnv !== 'development') {
    throw new RebuildRefusedError(
      'rebuild-dev only runs with APP_ENV=development (tests use reset-test).',
    );
  }
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const actual = rows[0]!.name;
  if (!options.designated || options.designated !== actual) {
    throw new RebuildRefusedError(
      'rebuild-dev drops every table: name the connected database to confirm it is disposable ' +
        '(--disposable <database>).',
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const result = await migrate(pool);
  await runSeed(pool, 'reference', options.appEnv);
  await runSeed(pool, 'dev', options.appEnv);
  return result;
}
