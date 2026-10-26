// Database command line: `migrate`, `seed`, `seed-dev`, `reset-test`.
// Usage: tsx src/db/cli.ts <command> [--env-file .env.test]   (or node dist/db/cli.js in production)
import { Pool } from 'pg';
import { loadConfigOrExit } from '../config/env.js';
import { migrate } from './migrator.js';
import { runSeed } from './seed.js';

const USAGE = 'Usage: db <migrate|seed|seed-dev|reset-test> [--env-file <path>]';

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const envFlag = rest.indexOf('--env-file');
  if (envFlag !== -1) {
    process.env.ENV_FILE = rest[envFlag + 1];
  }
  const config = loadConfigOrExit();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  const log = (message: string) => process.stdout.write(`${message}\n`);

  try {
    switch (command) {
      case 'migrate': {
        const result = await migrate(pool);
        log(
          result.applied.length > 0
            ? `Applied: ${result.applied.join(', ')}`
            : 'Database is up to date.',
        );
        await runSeed(pool, 'reference', config.APP_ENV);
        log('Reference data loaded.');
        break;
      }
      case 'seed':
        await runSeed(pool, 'reference', config.APP_ENV);
        log('Reference data loaded.');
        break;
      case 'seed-dev':
        await runSeed(pool, 'dev', config.APP_ENV);
        log('Development fixtures loaded.');
        break;
      case 'reset-test': {
        // Destructive, so allowed only against a test database.
        if (config.APP_ENV !== 'test') {
          throw new Error('reset-test only runs with APP_ENV=test (use --env-file .env.test).');
        }
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        const result = await migrate(pool);
        await runSeed(pool, 'reference', config.APP_ENV);
        log(`Test database reset. Applied: ${result.applied.join(', ')}`);
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
