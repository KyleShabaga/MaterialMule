import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { escapeIdentifier, escapeLiteral, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';

// Review fixes #99: the clean-install guide (docs/operations/clean-install.md) must never delete
// objects an old role owns in a database the operator keeps, and must keep the new login's
// password out of command lines. The guide's own SQL is read from the Markdown and run here.

const GUIDE = readFileSync(
  new URL('../../../../docs/operations/clean-install.md', import.meta.url),
  'utf8',
);

/** The SQL of the guide's here-string that starts with `-- <marker>`, dedented. */
function guideSql(marker: string): string {
  const match = new RegExp(`\\n( *)-- ${marker}\\n([\\s\\S]*?)\\n *'@`).exec(GUIDE);
  if (!match) throw new Error(`clean-install.md has no SQL block -- ${marker}`);
  const indent = match[1]!.length;
  return match[2]!
    .split('\n')
    .map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)))
    .join('\n');
}

/** psql's :'role' / :'new_owner' variables as bind parameters $1 / $2. */
const bind = (sql: string) => sql.replaceAll(":'role'", '$1').replaceAll(":'new_owner'", '$2');

describe('clean-install guide text (#99)', () => {
  it('never puts a password in a command and sets it with \\password', () => {
    expect(GUIDE).not.toMatch(/PASSWORD\s+'/i);
    expect(GUIDE).toContain(`-c '\\password materialmule'`);
    expect(GUIDE).toContain('CREATE ROLE materialmule LOGIN"');
    expect(GUIDE).toContain('[uri]::EscapeDataString(');
  });

  it('only runs DROP OWNED after REASSIGN OWNED, inside the hand-over block', () => {
    const handOver = guideSql('role-hand-over');
    expect(handOver.indexOf('REASSIGN OWNED')).toBeGreaterThan(0);
    expect(handOver.indexOf('REASSIGN OWNED')).toBeLessThan(handOver.indexOf('DROP OWNED'));
    // Anywhere else, DROP OWNED is only named in a warning, never given as a command to run
    // (the old fallback said `DROP OWNED BY <role>;`).
    const elsewhere = GUIDE.replace(/-- role-hand-over\n[\s\S]*?\n *'@/, '');
    expect(elsewhere).not.toMatch(/DROP OWNED BY\s+[<\w"%]/);
  });
});

// Runs anywhere a test database is configured: the guide's SQL parses and the read-only
// inspection runs; the hand-over refuses before changing anything.
describe.runIf(testDatabaseUrl)('clean-install guide SQL runs (#99)', () => {
  let pool: Pool;
  let me: string;
  beforeAll(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    me = (await pool.query<{ me: string }>('SELECT current_user AS me')).rows[0]!.me;
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('inspects the connected login without changing anything', async () => {
    const byDatabase = await pool.query(bind(guideSql('role-dependencies-by-database')), [me]);
    expect(byDatabase.fields.map((field) => field.name)).toEqual([
      'database',
      'dependency',
      'objects',
    ]);
    const inDatabase = await pool.query(bind(guideSql('role-dependencies-in-database')), [me]);
    expect(inDatabase.fields.map((field) => field.name)).toEqual(['object', 'dependency']);
  });

  it('refuses a hand-over to the role itself, in one transaction', async () => {
    const [setRoles, ...rest] = guideSql('role-hand-over').split(/;\n(?=DO )/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(bind(setRoles!), [me, me]);
      await expect(client.query(rest.join(';\n'))).rejects.toThrow(
        `new owner must be an existing role other than ${me}; nothing was changed`,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

// Creating roles needs a superuser, as roles.test.ts (CI's test database user is one).
async function isSuperuser(): Promise<boolean> {
  if (!testDatabaseUrl) return false;
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    return rows[0]?.rolsuper === true;
  } finally {
    await pool.end();
  }
}
const superuser = await isSuperuser();
if (!superuser && process.env.CI === 'true' && testDatabaseUrl) {
  throw new Error('CI must run the clean-install guide tests: the test user is no superuser.');
}

describe.runIf(superuser)('clean-install role cleanup on a kept database (#99)', () => {
  const suffix = randomBytes(4).toString('hex');
  const OLD = `ci99_old_${suffix}`;
  const KEEPER = `ci99_keeper_${suffix}`;
  let scratch: TestSchema;
  let admin: Pool;

  beforeAll(async () => {
    scratch = await createTestSchema();
    admin = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    await admin.query(`CREATE ROLE ${OLD} NOLOGIN`);
    await admin.query(`CREATE ROLE ${KEEPER} NOLOGIN`);
    // An unrelated table the old role owns, with data, and a privilege it was granted.
    await admin.query(`CREATE TABLE ${scratch.schema}.kept_records (id int, note text)`);
    await admin.query(
      `INSERT INTO ${scratch.schema}.kept_records VALUES (1, 'fictional'), (2, 'records')`,
    );
    await admin.query(`ALTER TABLE ${scratch.schema}.kept_records OWNER TO ${OLD}`);
    await admin.query(`CREATE TABLE ${scratch.schema}.shared_lookup (code text)`);
    await admin.query(`GRANT SELECT ON ${scratch.schema}.shared_lookup TO ${OLD}`);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${scratch.schema} CASCADE`);
      for (const role of [OLD, KEEPER]) {
        const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      }
      await admin.end();
    }
    await scratch?.pool.end().catch(() => undefined);
  });

  async function handOver(newOwner: string): Promise<void> {
    const [setRoles, ...rest] = guideSql('role-hand-over').split(/;\n(?=DO )/);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(bind(setRoles!), [OLD, newOwner]);
      await client.query(rest.join(';\n'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('walks the guide: DROP ROLE refuses, inspection names the table, hand-over keeps it', async () => {
    await expect(admin.query(`DROP ROLE ${OLD}`)).rejects.toMatchObject({ code: '2BP01' });

    const byDatabase = await admin.query<{ database: string; dependency: string }>(
      bind(guideSql('role-dependencies-by-database')),
      [OLD],
    );
    const database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!
      .db;
    expect(byDatabase.rows.filter((row) => row.database === database)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependency: 'owner' }),
        expect.objectContaining({ dependency: 'privileges' }),
      ]),
    );

    const inDatabase = await admin.query<{ object: string; dependency: string }>(
      bind(guideSql('role-dependencies-in-database')),
      [OLD],
    );
    expect(inDatabase.rows).toEqual(
      expect.arrayContaining([
        { object: `table ${scratch.schema}.kept_records`, dependency: 'owner' },
        { object: `table ${scratch.schema}.shared_lookup`, dependency: 'privileges' },
      ]),
    );

    // Refused, changing nothing: the role itself, or an owner that doesn't exist.
    await expect(handOver(OLD)).rejects.toThrow(/nothing was changed/);
    await expect(handOver(`ci99_missing_${suffix}`)).rejects.toThrow(/nothing was changed/);
    const owner = async () =>
      (
        await admin.query<{ owner: string }>(
          'SELECT tableowner AS owner FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
          [scratch.schema, 'kept_records'],
        )
      ).rows[0]!.owner;
    expect(await owner()).toBe(OLD);

    await handOver(KEEPER);
    expect(await owner()).toBe(KEEPER);
    const rows = await admin.query(
      `SELECT id, note FROM ${scratch.schema}.kept_records ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: 1, note: 'fictional' },
      { id: 2, note: 'records' },
    ]);
    expect(
      (await admin.query(bind(guideSql('role-dependencies-in-database')), [OLD])).rows,
    ).toEqual([]);

    await admin.query(`DROP ROLE ${OLD}`);
    // The table and the other table survive the role.
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM ${scratch.schema}.kept_records`)).rows[0],
    ).toEqual({ n: 2 });
    expect(
      (
        await admin.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
          `${scratch.schema}.shared_lookup`,
        ])
      ).rows[0],
    ).toEqual({ ok: true });
  });
});

describe.runIf(superuser && process.platform === 'win32')(
  'clean-install login password with reserved characters (#99)',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const LOGIN = `ci99_login_${suffix}`;
    // Fictional: an apostrophe, a dollar sign and URI separators, as the guide warns about.
    const PASSWORD = `it's$a/b@c:d%#?${randomBytes(4).toString('hex')}`;
    let admin: Pool;
    let database: string;

    beforeAll(async () => {
      admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
      // What `\password` does (it sends a SCRAM hash; a test can't type at its prompt).
      await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD ${escapeLiteral(PASSWORD)}`);
      await admin.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${LOGIN}`);
    });

    afterAll(async () => {
      if (admin) {
        await admin.query(`DROP OWNED BY ${LOGIN}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`);
        await admin.end();
      }
    });

    it("connects with the guide's percent-encoded DATABASE_URL, and the app accepts it", async () => {
      // The guide's command, with the password from the environment instead of the prompt.
      const encoded = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[uri]::EscapeDataString($env:CI99_PASSWORD)',
        ],
        { encoding: 'utf8', env: { ...process.env, CI99_PASSWORD: PASSWORD } },
      ).stdout.trim();
      expect(encoded).toMatch(/^it%27s%24a%2Fb%40c%3Ad%25%23%3F[0-9a-f]{8}$/);

      const base = new URL(testDatabaseUrl!);
      const url = `postgres://${LOGIN}:${encoded}@${base.host}/${database}`;
      expect(() =>
        loadConfig({
          APP_ENV: 'test',
          DATABASE_URL: url,
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        }),
      ).not.toThrow();
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        const { rows } = await pool.query<{ user: string }>('SELECT current_user AS user');
        expect(rows[0]!.user).toBe(LOGIN);
      } finally {
        await pool.end();
      }
    });
  },
);
