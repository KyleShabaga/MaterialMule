import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { migrate, readMigrations } from './migrator.js';
import { setUpDatabaseRoles } from './roles.js';
import { runSeed } from './seed.js';

// Creating roles needs a superuser, as on the host (postgres). CI's test database user is one;
// a local test user usually isn't, so locally this file is skipped with that reason.
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
  throw new Error('CI must run the database role tests: the test database user is no superuser.');
}

const suffix = randomBytes(4).toString('hex');
const MIGRATION_ROLE = `t20_owner_${suffix}`;
const APP_ROLE = `t20_app_${suffix}`;
const PASSWORDS = {
  [MIGRATION_ROLE]: randomBytes(16).toString('hex'),
  [APP_ROLE]: randomBytes(16).toString('hex'),
};

function urlFor(role: string, schema: string): string {
  const url = new URL(testDatabaseUrl!);
  url.username = role;
  url.password = PASSWORDS[role]!;
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/** The SQLSTATE a query fails with, or 'ok'. */
async function outcome(pool: Pool, sql: string): Promise<string> {
  try {
    await pool.query(sql);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'error';
  }
}

describe.runIf(superuser)('least-privilege database roles (TRP-T20)', () => {
  let scratch: TestSchema;
  let admin: Pool;
  let owner: Pool;
  let app: Pool;
  let database: string;

  beforeAll(async () => {
    scratch = await createTestSchema();
    admin = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;

    // First pass before any table exists, as on a fresh host.
    await setUpDatabaseRoles(admin, {
      migrationRole: MIGRATION_ROLE,
      appRole: APP_ROLE,
      schema: scratch.schema,
    });
    for (const [role, password] of Object.entries(PASSWORDS)) {
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
    owner = new Pool({ connectionString: urlFor(MIGRATION_ROLE, scratch.schema), max: 2 });
    app = new Pool({ connectionString: urlFor(APP_ROLE, scratch.schema), max: 2 });

    await migrate(owner);
    await runSeed(owner, 'reference', 'production');
    // Second pass applies the per-table exceptions to the tables that now exist.
    await setUpDatabaseRoles(admin, {
      migrationRole: MIGRATION_ROLE,
      appRole: APP_ROLE,
      schema: scratch.schema,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${scratch.schema} CASCADE`);
      await admin.query(`DROP OWNED BY ${MIGRATION_ROLE}, ${APP_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${MIGRATION_ROLE}`);
      // Put the shared test database back to PostgreSQL's default.
      await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO PUBLIC`);
      await admin.end();
    }
    await scratch?.pool.end().catch(() => undefined);
  });

  it('lets the migration role own the schema and every table', async () => {
    const { rows } = await admin.query<{ tableowner: string }>(
      'SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1',
      [scratch.schema],
    );
    expect(rows.map((r) => r.tableowner)).toEqual([MIGRATION_ROLE]);
  });

  it('gives neither role superuser, CREATEDB or CREATEROLE', async () => {
    const { rows } = await admin.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[MIGRATION_ROLE, APP_ROLE]],
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
      });
    }
  });

  it('lets the app role read and write rows', async () => {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Test RL', 'RL', 'test', 'active') RETURNING id`,
    );
    expect(
      await outcome(
        app,
        `UPDATE app_user SET display_name = 'Test RL2' WHERE id = '${rows[0]!.id}'`,
      ),
    ).toBe('ok');
    expect(await outcome(app, 'SELECT count(*) FROM location')).toBe('ok');
    expect(await outcome(app, `DELETE FROM app_user WHERE id = '${rows[0]!.id}'`)).toBe('ok');
  });

  it('never lets the app role change the schema or migration history', async () => {
    expect(await outcome(app, 'CREATE TABLE intruder (id int)')).toBe('42501');
    expect(await outcome(app, 'DROP TABLE project')).toBe('42501');
    expect(await outcome(app, 'ALTER TABLE project ADD COLUMN extra text')).toBe('42501');
    expect(await outcome(app, 'TRUNCATE project')).toBe('42501');
    expect(await outcome(app, 'DELETE FROM schema_migration')).toBe('42501');
    expect(await outcome(app, `INSERT INTO schema_migration (version) VALUES ('9999')`)).toBe(
      '42501',
    );
    const existing = await readMigrations();
    await expect(
      migrate(app, [
        ...existing,
        { version: '9999', name: 'intruder', sql: 'CREATE TABLE intruder (id int)', checksum: 'x' },
      ]),
    ).rejects.toThrow();
  });

  it('keeps audit events append-only for the app role', async () => {
    const privilege = async (kind: string) =>
      (
        await admin.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', [
          APP_ROLE,
          `${scratch.schema}.audit_event`,
          kind,
        ])
      ).rows[0]!.ok;
    expect(await privilege('INSERT')).toBe(true);
    expect(await privilege('UPDATE')).toBe(false);
    expect(await privilege('DELETE')).toBe(false);
    expect(await outcome(app, 'DELETE FROM audit_event')).toBe('42501');
  });

  it('keeps PUBLIC out of the database and the schema', async () => {
    const { rows } = await admin.query<{ connect: boolean; create: boolean }>(
      `SELECT has_database_privilege('public', $1, 'CONNECT') AS connect,
              has_schema_privilege('public', $2, 'CREATE') AS create`,
      [database, scratch.schema],
    );
    expect(rows[0]).toEqual({ connect: false, create: false });
  });

  it('runs the API as the app role', async () => {
    let api: INestApplication | undefined;
    try {
      api = await createApp(
        loadConfig({
          APP_ENV: 'test',
          DATABASE_URL: urlFor(APP_ROLE, scratch.schema),
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
          LOG_LEVEL: 'silent',
        }),
      );
      await api.init();
      const response = await request(api.getHttpServer()).get('/api/health');
      expect(response.status).toBe(200);
    } finally {
      await api?.close();
    }
  });

  it('is idempotent', async () => {
    const steps = await setUpDatabaseRoles(admin, {
      migrationRole: MIGRATION_ROLE,
      appRole: APP_ROLE,
      schema: scratch.schema,
    });
    expect(steps.some((step) => step.startsWith('created role'))).toBe(false);
  });

  it('refuses unsafe role names', async () => {
    await expect(
      setUpDatabaseRoles(admin, { migrationRole: 'Robert"; DROP', appRole: APP_ROLE }),
    ).rejects.toThrow(/lowercase letters/);
    await expect(
      setUpDatabaseRoles(admin, { migrationRole: APP_ROLE, appRole: APP_ROLE }),
    ).rejects.toThrow(/different roles/);
  });
});
