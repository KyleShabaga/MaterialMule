import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.js';
import { withTransaction } from './transaction.js';

const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

export type SeedSet = 'reference' | 'dev';

export class SeedRefusedError extends Error {
  override name = 'SeedRefusedError';
}

/** Runs a seed file in one transaction. Development fixtures are refused in production. */
export async function runSeed(pool: Pool, set: SeedSet, appEnv: AppConfig['APP_ENV']) {
  if (set === 'dev' && appEnv === 'production') {
    throw new SeedRefusedError('Refusing to load fictional development fixtures in production.');
  }
  const sql = await readFile(`${SEED_DIR}${set}.sql`, 'utf8');
  await withTransaction(pool, (client) => client.query(sql));
}
