import { escapeIdentifier, type Pool } from 'pg';
import { APP_READ_ONLY_TABLES, appendOnlyTables, assertRoleName } from './roles.js';

/**
 * Read-only database security check for the production host (MM-T68, run on the host by MM-T90
 * through Test-MaterialMuleSecurity.ps1). It connects as the app role, as the service does, and
 * reports whether the roles, privileges and server settings still match what setup-roles and the
 * runbook set up. It changes nothing and its output never contains a secret.
 */
export interface SecurityCheckRoles {
  appRole: string;
  migrationRole: string;
  /** Omitted until backups are set up (D39): the backup checks are skipped. */
  backupRole?: string;
  /** Schema holding the app's tables. `public` on the host; tests use a scratch schema. */
  schema?: string;
}

export type SecurityCheckStatus = 'pass' | 'fail' | 'skip';

export interface SecurityCheckResult {
  /** `roles` checks hold wherever setup-roles ran; `settings` depend on postgresql.conf. */
  area: 'roles' | 'settings';
  check: string;
  status: SecurityCheckStatus;
  detail: string;
}

/** Server settings the runbook sets, read from pg_settings (null when not visible). */
export type ServerSettings = Record<(typeof SETTING_NAMES)[number], string | null>;

const SETTING_NAMES = [
  'listen_addresses',
  'password_encryption',
  'log_statement',
  'log_connections',
] as const;

const LOCAL_ADDRESSES = new Set(['localhost', '127.0.0.1', '::1']);

export async function checkDatabaseSecurity(
  pool: Pool,
  roles: SecurityCheckRoles,
): Promise<SecurityCheckResult[]> {
  assertRoleName(roles.appRole, 'App role');
  assertRoleName(roles.migrationRole, 'Migration role');
  if (roles.backupRole !== undefined) assertRoleName(roles.backupRole, 'Backup role');
  const schema = roles.schema ?? 'public';
  const results: SecurityCheckResult[] = [];
  const add = (check: string, problems: string[], passDetail: string) =>
    results.push({
      area: 'roles',
      check,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail: problems.length === 0 ? passDetail : problems.join('; '),
    });

  const client = await pool.connect();
  try {
    const { rows: who } = await client.query<{ user: string; database: string }>(
      'SELECT current_user AS user, current_database() AS database',
    );
    const { user, database } = who[0]!;
    add(
      'connected-as-app-role',
      user === roles.appRole ? [] : [`connected as ${user}, expected ${roles.appRole}`],
      `connected as ${user}`,
    );

    const named = [
      roles.migrationRole,
      roles.appRole,
      ...(roles.backupRole ? [roles.backupRole] : []),
    ];
    const { rows: attributes } = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      rolconfig: string[] | null;
    }>(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconfig
         FROM pg_roles WHERE rolname = ANY($1)`,
      [named],
    );
    const attributeProblems: string[] = [];
    for (const role of named) {
      const row = attributes.find((candidate) => candidate.rolname === role);
      if (!row) {
        attributeProblems.push(`${role} does not exist`);
        continue;
      }
      const powers = (
        [
          ['SUPERUSER', row.rolsuper],
          ['CREATEDB', row.rolcreatedb],
          ['CREATEROLE', row.rolcreaterole],
          ['REPLICATION', row.rolreplication],
          ['BYPASSRLS', row.rolbypassrls],
        ] as const
      )
        .filter(([, has]) => has)
        .map(([name]) => name);
      if (powers.length > 0) attributeProblems.push(`${role} has ${powers.join(', ')}`);
    }
    add('role-attributes', attributeProblems, `${named.join(', ')}: no superuser or admin powers`);
    // PostgreSQL's privilege functions throw for an unknown role, so those checks fail instead.
    const exists = (role: string) => attributes.some((row) => row.rolname === role);
    const missing = (role: string) => `${role} does not exist`;

    const schemaId = escapeIdentifier(schema);
    const { rows: ownership } = await client.query<{
      schema_owner: string;
      public_create: boolean;
      public_connect: boolean;
    }>(
      `SELECT pg_get_userbyid(n.nspowner) AS schema_owner,
              has_schema_privilege('public', n.oid, 'CREATE') AS public_create,
              has_database_privilege('public', current_database(), 'CONNECT') AS public_connect
         FROM pg_namespace n WHERE n.nspname = $1`,
      [schema],
    );
    const schemaRow = ownership[0];
    const { rows: owners } = await client.query<{ owner: string; tables: string }>(
      `SELECT tableowner AS owner, count(*)::text AS tables
         FROM pg_tables WHERE schemaname = $1 GROUP BY tableowner ORDER BY tableowner`,
      [schema],
    );
    const ownerProblems: string[] = [];
    if (!schemaRow) {
      ownerProblems.push(`schema ${schema} not found`);
    } else {
      if (schemaRow.schema_owner !== roles.migrationRole) {
        ownerProblems.push(`schema ${schema} is owned by ${schemaRow.schema_owner}`);
      }
      if (!exists(roles.appRole)) {
        ownerProblems.push(missing(roles.appRole));
      } else if (
        (
          await client.query<{ ok: boolean }>(
            `SELECT has_schema_privilege($1, $2, 'CREATE') AS ok`,
            [roles.appRole, schema],
          )
        ).rows[0]!.ok
      ) {
        ownerProblems.push(`${roles.appRole} may create objects in ${schema}`);
      }
    }
    for (const row of owners) {
      if (row.owner !== roles.migrationRole) {
        ownerProblems.push(`${row.owner} owns ${row.tables} table(s)`);
      }
    }
    add(
      'schema-ownership',
      ownerProblems,
      `${roles.migrationRole} owns ${schema} and every table; ${roles.appRole} can't change the schema`,
    );

    add(
      'public-access',
      [
        ...(schemaRow?.public_connect ? [`PUBLIC may connect to ${database}`] : []),
        ...(schemaRow?.public_create ? [`PUBLIC may create objects in ${schema}`] : []),
      ],
      `PUBLIC can't connect to ${database} or create in ${schema}`,
    );

    const privilege = async (role: string, table: string, kind: string) =>
      (
        await client.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', [
          role,
          `${schemaId}.${escapeIdentifier(table)}`,
          kind,
        ])
      ).rows[0]!.ok;
    const writeKinds = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
    /** The privileges among `kinds` that `role` holds on `table`. */
    const heldPrivileges = async (role: string, table: string, kinds: string[]) => {
      const found: string[] = [];
      for (const kind of kinds) if (await privilege(role, table, kind)) found.push(kind);
      return found;
    };

    const appendOnly = await appendOnlyTables(client, schema);
    if (!exists(roles.appRole)) {
      for (const check of ['read-only-tables', 'append-only-tables', 'no-truncate']) {
        add(check, [missing(roles.appRole)], '');
      }
    } else {
      const readOnlyProblems: string[] = [];
      for (const table of APP_READ_ONLY_TABLES) {
        const held = await heldPrivileges(roles.appRole, table, writeKinds);
        if (held.length > 0)
          readOnlyProblems.push(`${roles.appRole} has ${held.join(', ')} on ${table}`);
      }
      add('read-only-tables', readOnlyProblems, `${APP_READ_ONLY_TABLES.join(', ')}: read-only`);

      const appendProblems: string[] = [];
      if (appendOnly.length === 0) appendProblems.push(`no append-only tables found in ${schema}`);
      for (const table of appendOnly) {
        const held = await heldPrivileges(roles.appRole, table, ['UPDATE', 'DELETE', 'TRUNCATE']);
        if (held.length > 0)
          appendProblems.push(`${roles.appRole} has ${held.join(', ')} on ${table}`);
      }
      add(
        'append-only-tables',
        appendProblems,
        `${appendOnly.length} append-only tables: ${roles.appRole} can only add rows`,
      );

      const { rows: truncatable } = await client.query<{ table: string }>(
        `SELECT tablename AS table FROM pg_tables
          WHERE schemaname = $1 AND has_table_privilege($2, quote_ident(schemaname) || '.' || quote_ident(tablename), 'TRUNCATE')
          ORDER BY 1`,
        [schema, roles.appRole],
      );
      add(
        'no-truncate',
        truncatable.length === 0
          ? []
          : [`${roles.appRole} may TRUNCATE ${truncatable.map((r) => r.table).join(', ')}`],
        `${roles.appRole} can't TRUNCATE any table`,
      );
    }

    if (roles.backupRole && !exists(roles.backupRole)) {
      add('backup-role-read-only', [missing(roles.backupRole)], '');
    } else if (roles.backupRole) {
      const backup = roles.backupRole;
      const backupProblems: string[] = [];
      const config = attributes.find((row) => row.rolname === backup)?.rolconfig ?? [];
      if (!config.includes('default_transaction_read_only=on')) {
        backupProblems.push(`${backup} is not read-only by default`);
      }
      const { rows: tables } = await client.query<{
        table: string;
        can_read: boolean;
        can_write: boolean;
      }>(
        `SELECT tablename AS table,
                has_table_privilege($2, quote_ident(schemaname) || '.' || quote_ident(tablename), 'SELECT') AS can_read,
                has_table_privilege($2, quote_ident(schemaname) || '.' || quote_ident(tablename), 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_write
           FROM pg_tables WHERE schemaname = $1 ORDER BY 1`,
        [schema, backup],
      );
      const unreadable = tables.filter((row) => !row.can_read).map((row) => row.table);
      const writable = tables.filter((row) => row.can_write).map((row) => row.table);
      if (unreadable.length > 0)
        backupProblems.push(`${backup} can't read ${unreadable.join(', ')}`);
      if (writable.length > 0) backupProblems.push(`${backup} may write ${writable.join(', ')}`);
      add('backup-role-read-only', backupProblems, `${backup} reads every table and writes none`);
    } else {
      results.push({
        area: 'roles',
        check: 'backup-role-read-only',
        status: 'skip',
        detail: 'no backup role given (backups not set up yet, D39)',
      });
    }

    const { rows: settings } = await client.query<{ name: string; setting: string }>(
      'SELECT name, setting FROM pg_settings WHERE name = ANY($1)',
      [[...SETTING_NAMES]],
    );
    const values = Object.fromEntries(
      SETTING_NAMES.map((name) => [
        name,
        settings.find((row) => row.name === name)?.setting ?? null,
      ]),
    ) as ServerSettings;
    results.push(...evaluateServerSettings(values));
  } finally {
    client.release();
  }
  return results;
}

/** The runbook's postgresql.conf settings (local only, SCRAM, no statement logging, connections logged). */
export function evaluateServerSettings(settings: ServerSettings): SecurityCheckResult[] {
  const result = (
    check: string,
    value: string | null,
    ok: (value: string) => boolean,
    want: string,
  ) =>
    ({
      area: 'settings',
      check,
      status: value === null ? 'skip' : ok(value) ? 'pass' : 'fail',
      detail:
        value === null
          ? 'not visible to this role'
          : `${value === '' ? "''" : value} (want ${want})`,
    }) satisfies SecurityCheckResult;
  return [
    result(
      'listen-addresses',
      settings.listen_addresses,
      (value) =>
        value
          .split(',')
          .map((address) => address.trim())
          .every((address) => LOCAL_ADDRESSES.has(address)),
      'localhost',
    ),
    result(
      'password-encryption',
      settings.password_encryption,
      (value) => value === 'scram-sha-256',
      'scram-sha-256',
    ),
    result('log-statement', settings.log_statement, (value) => value === 'none', 'none'),
    result('log-connections', settings.log_connections, (value) => value === 'on', 'on'),
  ];
}

/** One `PASS|FAIL|SKIP <check>: <detail>` line per result, as Test-MaterialMuleSecurity.ps1 reads them. */
export function formatSecurityCheck(results: SecurityCheckResult[]): string[] {
  return results.map((r) => `${r.status.toUpperCase()} ${r.check}: ${r.detail}`);
}
