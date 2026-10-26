// `npm run bench:seed -- --size ten-year|stress [--seed N] [--as-of YYYY-MM-DD] [--env-file F]`
// Drops and rebuilds the benchmark database named in the env file (default apps/api/.env.bench),
// then loads the fictional MM-T19 dataset. Refuses production and any database whose name lacks
// "bench" or "test".
import { Pool } from 'pg';
import { loadConfigOrExit } from '../config/env.js';
import { migrate } from '../db/migrator.js';
import { runSeed } from '../db/seed.js';
import { withTransaction } from '../db/transaction.js';
import { parseArgs, useEnvFile } from './cli-args.js';
import { BENCH_PROFILES, DEFAULT_AS_OF, generateBenchData } from './generate.js';
import { assertBenchTarget } from './guard.js';
import { DEFAULT_BENCH_SEED } from './random.js';
import { datasetFingerprint, tableCounts } from './verify.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  useEnvFile(args);
  const profile = BENCH_PROFILES[args.get('size') ?? 'ten-year'];
  if (!profile || profile.name === 'tiny') {
    throw new Error('--size must be ten-year or stress');
  }
  const seed = Number(args.get('seed') ?? DEFAULT_BENCH_SEED);
  const asOf = args.get('as-of') ?? DEFAULT_AS_OF;
  if (!Number.isInteger(seed) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('--seed must be a whole number and --as-of a date (YYYY-MM-DD)');
  }
  const config = loadConfigOrExit();
  const database = assertBenchTarget(config.DATABASE_URL, config.APP_ENV);
  const log = (message: string) => process.stdout.write(`${message}\n`);
  log(`Benchmark seed: profile ${profile.name}, seed ${seed}, as of ${asOf}, database ${database}`);

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  const started = Date.now();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    await runSeed(pool, 'reference', config.APP_ENV);
    // Fictional sign-in identities (admin, at, pe, ...) used by the load script.
    await runSeed(pool, 'dev', config.APP_ENV);
    const counts = await withTransaction(pool, (client) =>
      generateBenchData(client, { profile, seed, asOf, log }),
    );
    log(`Generated: ${JSON.stringify(counts)}`);
    await pool.query('VACUUM (ANALYZE)');
    log(`Table rows: ${JSON.stringify(await tableCounts(pool))}`);
    log(`Fingerprint: ${await datasetFingerprint(pool)}`);
    log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
