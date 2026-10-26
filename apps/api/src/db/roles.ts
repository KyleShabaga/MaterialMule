import { escapeIdentifier, type Pool, type PoolClient } from 'pg';

/**
 * Least-privilege PostgreSQL roles for the production host (TRP-T20):
 * - the migration role owns the schema and every table, and is used only by the deploy script;
 * - the app role (the API service) can read and write rows but never change the schema.
 * Run as a superuser (postgres) on the production database. Idempotent: run it once before the
 * first migration (so tables the migration role creates are granted automatically) and again
 * after it (to apply the per-table exceptions below to tables that now exist).
 * Passwords are never handled here; set them with psql's \password.
 */
export interface DatabaseRoleNames {
  migrationRole: string;
  appRole: string;
  /** Schema holding the app's tables. `public` on the host; tests use a scratch schema. */
  schema?: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tables the API must not change even though it can change rows elsewhere. */
const APP_READ_ONLY_TABLES = ['schema_migration'];
/** Append-only: the API may add rows, never change or remove them (trigger in 0002 too). */
const APP_APPEND_ONLY_TABLES = ['audit_event'];

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
    for (const [role, id] of [
      [names.migrationRole, owner],
      [names.appRole, app],
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
    // CREATE lets migrations add trusted extensions such as pg_trgm (0010) without a superuser.
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
    for (const table of APP_READ_ONLY_TABLES) {
      if (await tableExists(client, schema, table)) {
        await run(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${schemaId}.${escapeIdentifier(table)} FROM ${app}`,
          `${table}: read-only for the app role`,
        );
      }
    }
    for (const table of APP_APPEND_ONLY_TABLES) {
      if (await tableExists(client, schema, table)) {
        await run(
          `REVOKE UPDATE, DELETE, TRUNCATE ON ${schemaId}.${escapeIdentifier(table)} FROM ${app}`,
          `${table}: append-only for the app role`,
        );
      }
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
