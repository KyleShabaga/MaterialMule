import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { APPEND_ONLY_TABLES, appendOnlyTables } from './roles.js';
import {
  checkDatabaseSecurity,
  evaluateServerSettings,
  formatSecurityCheck,
  type SecurityCheckResult,
} from './security-check.js';

// The passing case needs the real roles, so it lives in roles.test.ts (superuser, CI). Here the
// test login plays every role: it owns the schema and can do anything to its tables, which is
// exactly what the check must report as failures (MM-T68).

const byCheck = (results: SecurityCheckResult[]) =>
  Object.fromEntries(results.map((result) => [result.check, result]));

describe('evaluateServerSettings (MM-T68)', () => {
  it('passes the runbook settings', () => {
    const results = evaluateServerSettings({
      listen_addresses: 'localhost',
      password_encryption: 'scram-sha-256',
      log_statement: 'none',
      log_connections: 'on',
    });
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(
      evaluateServerSettings({ ...settingsOk(), listen_addresses: '127.0.0.1, ::1' })[0]!.status,
    ).toBe('pass');
  });

  it('fails anything that opens the database or logs too much or too little', () => {
    const results = byCheck(
      evaluateServerSettings({
        listen_addresses: '*',
        password_encryption: 'md5',
        log_statement: 'all',
        log_connections: 'off',
      }),
    );
    expect(results['listen-addresses']).toMatchObject({
      status: 'fail',
      detail: '* (want localhost)',
    });
    expect(results['password-encryption']!.status).toBe('fail');
    expect(results['log-statement']!.status).toBe('fail');
    expect(results['log-connections']!.status).toBe('fail');
    expect(
      byCheck(evaluateServerSettings({ ...settingsOk(), listen_addresses: 'localhost,10.0.0.5' }))[
        'listen-addresses'
      ]!.status,
    ).toBe('fail');
  });

  it('skips a setting the role cannot see', () => {
    expect(evaluateServerSettings({ ...settingsOk(), log_connections: null })[3]).toMatchObject({
      status: 'skip',
    });
  });

  it('formats one PASS/FAIL/SKIP line per check', () => {
    expect(
      formatSecurityCheck([
        { area: 'roles', check: 'a', status: 'pass', detail: 'fine' },
        { area: 'settings', check: 'b', status: 'fail', detail: 'bad' },
        { area: 'roles', check: 'c', status: 'skip', detail: 'n/a' },
      ]),
    ).toEqual(['PASS a: fine', 'FAIL b: bad', 'SKIP c: n/a']);
  });
});

function settingsOk() {
  return {
    listen_addresses: 'localhost',
    password_encryption: 'scram-sha-256',
    log_statement: 'none',
    log_connections: 'on',
  };
}

describe.runIf(testDatabaseUrl)('database security check (MM-T68)', () => {
  let db: TestSchema;
  let me: string;
  let superuser: boolean;

  beforeAll(async () => {
    db = await createMigratedSchema();
    const { rows } = await db.pool.query<{ me: string; superuser: boolean }>(
      'SELECT current_user AS me, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );
    ({ me, superuser } = rows[0]!);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('finds every append-only history table by its trigger', async () => {
    const tables = await appendOnlyTables(db.pool, db.schema);
    expect(tables).toEqual(
      expect.arrayContaining([
        'audit_event',
        'movement_event',
        'move_action',
        'test_request_status_history',
        'action_item_assignment',
        'retention_hold_unit',
        'disposal_removal',
        'tested_unit_removal',
      ]),
    );
    // Drift guard: a new history table whose trigger is named *append_only* must use one of the
    // known functions, or setup-roles would leave the app role able to update it.
    const { rows } = await db.pool.query<{ table: string }>(
      `SELECT DISTINCT c.relname AS table FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND t.tgname LIKE '%append_only%'`,
      [db.schema],
    );
    expect(rows.map((row) => row.table).filter((table) => !tables.includes(table))).toEqual([]);
    // #102: the independent inventory is exactly what the migrations protect, trigger by trigger.
    expect(APPEND_ONLY_TABLES.map((entry) => entry.table).sort()).toEqual([...tables].sort());
  });

  it('#102: passes the trigger check on a freshly migrated schema', async () => {
    const results = byCheck(
      await checkDatabaseSecurity(db.pool, { appRole: me, migrationRole: me, schema: db.schema }),
    );
    expect(results['append-only-triggers']).toMatchObject({ status: 'pass' });
  });

  it('#102: reports missing or disabled protection by table, and still checks those tables', async () => {
    // A separate schema, so the drift never reaches the other tests in this file.
    const drifted = await createMigratedSchema();
    try {
      const id = (table: string) => `${drifted.schema}.${table}`;
      await drifted.pool.query(`DROP TRIGGER audit_event_no_update_delete ON ${id('audit_event')}`);
      await drifted.pool.query(`DROP TRIGGER audit_event_no_truncate ON ${id('audit_event')}`);
      await drifted.pool.query(
        `ALTER TABLE ${id('movement_event')} DISABLE TRIGGER movement_event_append_only`,
      );
      await drifted.pool.query(
        `ALTER TABLE ${id('disposal_removal')} ENABLE REPLICA TRIGGER disposal_removal_append_only`,
      );
      // Nothing finds audit_event through its triggers any more.
      expect(await appendOnlyTables(drifted.pool, drifted.schema)).not.toContain('audit_event');

      const results = byCheck(
        await checkDatabaseSecurity(drifted.pool, {
          appRole: me,
          migrationRole: me,
          schema: drifted.schema,
        }),
      );
      expect(results['append-only-triggers']).toMatchObject({ status: 'fail' });
      expect(results['append-only-triggers']!.detail.split('; ')).toEqual([
        'audit_event: trigger audit_event_no_update_delete is missing, ' +
          'trigger audit_event_no_truncate is missing',
        'movement_event: trigger movement_event_append_only is disabled',
        'disposal_removal: trigger disposal_removal_append_only is disabled',
      ]);
      // The privilege check still covers audit_event (this login owns it, so it fails here).
      expect(results['append-only-tables']!.detail).toContain(
        `${me} has UPDATE, DELETE, TRUNCATE on audit_event`,
      );
    } finally {
      await drifted.drop();
    }
  }, 60_000);

  it('reports a login that owns everything as failing the role checks', async () => {
    const results = byCheck(
      await checkDatabaseSecurity(db.pool, { appRole: me, migrationRole: me, schema: db.schema }),
    );
    expect(results['connected-as-app-role']!.status).toBe('pass');
    expect(results['role-attributes']!.status).toBe(superuser ? 'fail' : 'pass');
    expect(results['schema-ownership']).toMatchObject({ status: 'fail' });
    expect(results['schema-ownership']!.detail).toContain(
      `${me} may create objects in ${db.schema}`,
    );
    expect(results['append-only-tables']).toMatchObject({ status: 'fail' });
    expect(results['append-only-tables']!.detail).toContain(
      `${me} has UPDATE, DELETE, TRUNCATE on audit_event`,
    );
    expect(results['read-only-tables']!.detail).toContain(
      `${me} has INSERT, UPDATE, DELETE, TRUNCATE on schema_migration`,
    );
    expect(results['no-truncate']!.status).toBe('fail');
    expect(results['backup-role-read-only']!.status).toBe('skip');
    expect(Object.keys(results)).toEqual(
      expect.arrayContaining([
        'listen-addresses',
        'password-encryption',
        'log-statement',
        'log-connections',
      ]),
    );
  });

  it('fails when connected as another role or a named role is missing', async () => {
    const results = byCheck(
      await checkDatabaseSecurity(db.pool, {
        appRole: 'mm_t68_missing_app',
        migrationRole: me,
        backupRole: 'mm_t68_missing_backup',
        schema: db.schema,
      }),
    );
    expect(results['connected-as-app-role']).toMatchObject({
      status: 'fail',
      detail: `connected as ${me}, expected mm_t68_missing_app`,
    });
    expect(results['role-attributes']!.detail).toContain('mm_t68_missing_app does not exist');
    expect(results['role-attributes']!.detail).toContain('mm_t68_missing_backup does not exist');
    expect(results['backup-role-read-only']!.status).toBe('fail');
  });

  it('refuses unsafe role names before querying', async () => {
    await expect(
      checkDatabaseSecurity(db.pool, { appRole: 'x"; DROP', migrationRole: me }),
    ).rejects.toThrow(/lowercase letters/);
  });

  it('never puts the connection password in its output', async () => {
    const password = new URL(testDatabaseUrl!).password;
    const lines = formatSecurityCheck(
      await checkDatabaseSecurity(db.pool, { appRole: me, migrationRole: me, schema: db.schema }),
    );
    if (password) expect(lines.join('\n')).not.toContain(decodeURIComponent(password));
  });
});
