import { escapeIdentifier, type Pool, type PoolClient } from 'pg';

/**
 * Least-privilege PostgreSQL roles for the production host (MM-T20):
 * - the migration role owns the schema and every table, and is used only by the deploy script;
 * - the app role (the API service) can read and write rows but never change the schema;
 * - the optional backup role (MM-T21, pg_dump and the monitor task) can only read.
 * Run as a superuser (postgres) on the production database. Idempotent: run it once before the
 * first migration (so tables the migration role creates are granted automatically) and again
 * after it (to apply the per-table exceptions below to tables that now exist).
 * Passwords are never handled here; set them with psql's \password.
 */
export interface DatabaseRoleNames {
  migrationRole: string;
  appRole: string;
  /** Read-only role for scheduled backups (MM-T21). Omitted: no backup role is set up. */
  backupRole?: string;
  /** Schema holding the app's tables. `public` on the host; tests use a scratch schema. */
  schema?: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tables the API must not change even though it can change rows elsewhere. */
export const APP_READ_ONLY_TABLES = ['schema_migration'];
/**
 * Trigger functions that refuse every UPDATE and DELETE on their table. A table guarded by one of
 * them is append-only, and the app role loses UPDATE and DELETE on it as a second layer (MM-T68).
 */
export const APPEND_ONLY_TRIGGER_FUNCTIONS = [
  'audit_event_is_append_only',
  'movement_history_is_append_only',
  'lab_append_only',
];

export type ProtectedEvent = 'UPDATE' | 'DELETE' | 'TRUNCATE';

export interface AppendOnlyTable {
  table: string;
  /** The triggers that must exist and be enabled, the function each runs and what it refuses. */
  triggers: { name: string; function: string; events: ProtectedEvent[] }[];
}

const rowGuard = (table: string, fn: string): AppendOnlyTable => ({
  table,
  triggers: [{ name: `${table}_append_only`, function: fn, events: ['UPDATE', 'DELETE'] }],
});

/**
 * The append-only tables, listed independently of the database (review fix #102). Setup and the
 * security check used to find them only through their triggers, so a dropped trigger also hid
 * its table: setup granted the app role UPDATE and DELETE again and the check still passed. This
 * list never depends on the triggers; a migration that adds an append-only table adds it here
 * (security-check.test.ts compares it with a freshly migrated schema).
 */
export const APPEND_ONLY_TABLES: AppendOnlyTable[] = [
  {
    table: 'audit_event',
    triggers: [
      {
        name: 'audit_event_no_update_delete',
        function: 'audit_event_is_append_only',
        events: ['UPDATE', 'DELETE'],
      },
      {
        name: 'audit_event_no_truncate',
        function: 'audit_event_is_append_only',
        events: ['TRUNCATE'],
      },
    ],
  },
  rowGuard('movement_event', 'movement_history_is_append_only'),
  rowGuard('move_action', 'movement_history_is_append_only'),
  // STRATA-123 (0041): the link from an undone move to the move that undid it.
  rowGuard('movement_reversal', 'movement_history_is_append_only'),
  ...[
    'action_item_assignment',
    'disposal_removal',
    // STRATA-92 (0047): disposal scan intents, written once per intent ID.
    'disposal_scan_intent',
    'lab_comment_revision',
    'program_amendment',
    'program_lifecycle_event',
    'program_priority_history',
    'retention_extension_unit',
    'retention_hold_unit',
    'retention_request_unit',
    'test_request_identity_revision',
    'test_request_review_event',
    'test_request_status_history',
    'test_request_unit_link',
    'tested_unit_removal',
  ].map((table) => rowGuard(table, 'lab_append_only')),
];

export function assertRoleName(name: string, label: string): void {
  if (!ROLE_NAME.test(name)) {
    throw new Error(`${label} must be lowercase letters, digits and underscores (max 63)`);
  }
}

export async function setUpDatabaseRoles(pool: Pool, names: DatabaseRoleNames): Promise<string[]> {
  assertRoleName(names.migrationRole, 'Migration role');
  assertRoleName(names.appRole, 'App role');
  if (names.migrationRole === names.appRole) {
    throw new Error('The migration role and the app role must be different roles');
  }
  if (names.backupRole !== undefined) {
    assertRoleName(names.backupRole, 'Backup role');
    if (names.backupRole === names.migrationRole || names.backupRole === names.appRole) {
      throw new Error('The backup role must differ from the migration and app roles');
    }
  }
  const schema = names.schema ?? 'public';
  const owner = escapeIdentifier(names.migrationRole);
  const app = escapeIdentifier(names.appRole);
  const schemaId = escapeIdentifier(schema);

  const client = await pool.connect();
  const done: string[] = [];
  const run = async (sql: string, summary: string) => {
    await client.query(sql);
    done.push(summary);
  };
  try {
    await client.query('BEGIN');
    const database = escapeIdentifier(
      (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db,
    );
    const backup = names.backupRole ? escapeIdentifier(names.backupRole) : null;
    for (const [role, id] of [
      [names.migrationRole, owner],
      [names.appRole, app],
      ...(names.backupRole && backup ? [[names.backupRole, backup] as const] : []),
    ] as const) {
      if (!(await roleExists(client, role))) {
        // LOGIN without a password: nobody can sign in as it until an admin sets one.
        await run(
          `CREATE ROLE ${id} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
          `created role ${role}`,
        );
      }
    }

    await run(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`, 'database closed to PUBLIC');
    // CREATE lets migrations add trusted extensions such as pg_trgm without a superuser.
    await run(
      `GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO ${owner}`,
      'migration role may connect and add trusted extensions',
    );
    await run(`GRANT CONNECT ON DATABASE ${database} TO ${app}`, 'app role may connect');

    await run(
      `ALTER SCHEMA ${schemaId} OWNER TO ${owner}`,
      `schema ${schema} owned by migration role`,
    );
    await run(`REVOKE ALL ON SCHEMA ${schemaId} FROM PUBLIC`, 'schema closed to PUBLIC');
    await run(
      `GRANT USAGE ON SCHEMA ${schemaId} TO ${app}`,
      'app role may use the schema (no CREATE)',
    );

    // Tables and sequences the migration role creates later.
    await run(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schemaId} ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
      'future tables: app role reads and writes rows',
    );
    await run(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schemaId} ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
      'future sequences: app role may use',
    );
    // Tables that already exist.
    await run(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaId} TO ${app}`,
      'existing tables: app role reads and writes rows',
    );
    await run(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaId} TO ${app}`,
      'existing sequences: app role may use',
    );
    if (names.backupRole && backup) {
      await grantReadOnly(run, { database, schemaId, owner, backup, role: names.backupRole });
    }
    for (const table of APP_READ_ONLY_TABLES) {
      if (await tableExists(client, schema, table)) {
        await run(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${schemaId}.${escapeIdentifier(table)} FROM ${app}`,
          `${table}: read-only for the app role`,
        );
      }
    }
    // The independent inventory plus anything else a trigger marks append-only, so a dropped
    // trigger never brings back UPDATE or DELETE (#102). Inventory tables not created yet are
    // skipped; setup runs again after the migration, as the runbook says.
    const appendOnly = new Set(await appendOnlyTables(client, schema));
    for (const { table } of APPEND_ONLY_TABLES) {
      if (await tableExists(client, schema, table)) appendOnly.add(table);
    }
    for (const table of [...appendOnly].sort()) {
      await run(
        `REVOKE UPDATE, DELETE, TRUNCATE ON ${schemaId}.${escapeIdentifier(table)} FROM ${app}`,
        `${table}: append-only for the app role`,
      );
    }
    await client.query('COMMIT');
    return done;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The backup role reads every table and sequence (pg_dump, the monitor's print-queue check) and
 * nothing else: no writes, no schema changes, and read-only transactions by default.
 */
async function grantReadOnly(
  run: (sql: string, summary: string) => Promise<void>,
  ids: { database: string; schemaId: string; owner: string; backup: string; role: string },
): Promise<void> {
  const { database, schemaId, owner, backup, role } = ids;
  await run(`GRANT CONNECT ON DATABASE ${database} TO ${backup}`, 'backup role may connect');
  await run(`GRANT USAGE ON SCHEMA ${schemaId} TO ${backup}`, 'backup role may use the schema');
  await run(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schemaId} ` +
      `GRANT SELECT ON TABLES TO ${backup}`,
    'future tables: backup role reads',
  );
  await run(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schemaId} ` +
      `GRANT SELECT ON SEQUENCES TO ${backup}`,
    'future sequences: backup role reads',
  );
  await run(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaId} TO ${backup}`,
    'existing tables: backup role reads',
  );
  await run(
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schemaId} TO ${backup}`,
    'existing sequences: backup role reads',
  );
  // Belt and braces: even a mistaken grant can't be used to write from this role.
  await run(
    `ALTER ROLE ${backup} SET default_transaction_read_only = on`,
    `${role}: read-only transactions by default`,
  );
}

/**
 * Tables in `schema` with a row trigger running one of the append-only functions, by name. Only a
 * cross-check: what must be protected comes from APPEND_ONLY_TABLES, which can't drift with the
 * database.
 */
export async function appendOnlyTables(
  client: Pick<PoolClient, 'query'>,
  schema: string,
): Promise<string[]> {
  const { rows } = await client.query<{ table: string }>(
    `SELECT DISTINCT c.relname AS table
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = $1 AND NOT t.tgisinternal AND p.proname = ANY($2)
      ORDER BY 1`,
    [schema, APPEND_ONLY_TRIGGER_FUNCTIONS],
  );
  return rows.map((row) => row.table);
}

async function roleExists(client: PoolClient, role: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return result.rowCount === 1;
}

async function tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
    [schema, table],
  );
  return result.rowCount === 1;
}
