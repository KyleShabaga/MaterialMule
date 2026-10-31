// Database command line: `migrate`, `seed`, `seed-dev`, `reset-test`, `rebuild-dev`, `setup-roles`,
// `security-check`.
// Usage: tsx src/db/cli.ts <command> [--env-file .env.test]   (or node dist/db/cli.js in production)
// rebuild-dev (MM-AO02, development only): tsx src/db/cli.ts rebuild-dev --disposable <database>
//   drops and rebuilds the named, connected development database with reference data and fixtures.
// setup-roles (MM-T20, host only): node dist/db/cli.js setup-roles <migration-role> <app-role> [<backup-role>]
//   the optional backup role (MM-T21) gets read-only access for pg_dump and the monitor task;
//   connects with DATABASE_ADMIN_URL (a superuser, password from PGPASSWORD) instead of the env file.
// security-check (MM-T68, host only, read-only): node dist/db/cli.js security-check --env-file <service env>
//   --app-role <name> --migration-role <name> [--backup-role <name>]
//   connects as the app role and prints PASS/FAIL/SKIP lines; exit 0 all good, 1 a check failed,
//   2 the check couldn't run.
import { Pool } from 'pg';
import { loadConfigOrExit } from '../config/env.js';
import { migrate } from './migrator.js';
import { rebuildDisposableDatabase } from './rebuild.js';
import { resetTestDatabase } from './reset-test.js';
import { setUpDatabaseRoles } from './roles.js';
import { checkDatabaseSecurity, formatSecurityCheck } from './security-check.js';
import { runSeed } from './seed.js';

const USAGE =
  'Usage: db <migrate|seed|seed-dev|reset-test> [--env-file <path>]\n' +
  '       db rebuild-dev --disposable <database> [--env-file <path>]\n' +
  '       db setup-roles <migration-role> <app-role> [<backup-role>]   (with DATABASE_ADMIN_URL set)\n' +
  '       db security-check --app-role <name> --migration-role <name> [--backup-role <name>] [--env-file <path>]';

/** The value after `--name`, or undefined. */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Creates and grants the production roles (see roles.ts). Never reads the app's env file. */
async function setupRoles([migrationRole, appRole, backupRole]: string[]): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl || !/^postgres(ql)?:\/\/.+/.test(adminUrl) || !migrationRole || !appRole) {
    throw new Error(USAGE);
  }
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (const step of await setUpDatabaseRoles(pool, { migrationRole, appRole, backupRole })) {
      process.stdout.write(`${step}\n`);
    }
  } finally {
    await pool.end();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'setup-roles') {
    await setupRoles(rest);
    return;
  }
  const envFile = option(rest, '--env-file');
  if (envFile !== undefined) {
    process.env.ENV_FILE = envFile;
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
        // Destructive, so allowed only against a test database (see reset-test.ts).
        const result = await resetTestDatabase(pool, { appEnv: config.APP_ENV });
        log(`Test database reset. Applied: ${result.applied.join(', ')}`);
        break;
      }
      case 'security-check': {
        const appRole = option(rest, '--app-role');
        const migrationRole = option(rest, '--migration-role');
        if (!appRole || !migrationRole) throw new Error(USAGE);
        const results = await checkDatabaseSecurity(pool, {
          appRole,
          migrationRole,
          backupRole: option(rest, '--backup-role'),
        });
        for (const line of formatSecurityCheck(results)) log(line);
        if (results.some((result) => result.status === 'fail')) process.exitCode = 1;
        break;
      }
      case 'rebuild-dev': {
        const result = await rebuildDisposableDatabase(pool, {
          appEnv: config.APP_ENV,
          designated: option(rest, '--disposable'),
        });
        log(`Development database rebuilt. Applied: ${result.applied.join(', ')}`);
        log('Reference data and development fixtures loaded.');
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
  // security-check keeps 1 for "a check failed"; anything that stopped it running is 2.
  process.exit(process.argv[2] === 'security-check' ? 2 : 1);
});
