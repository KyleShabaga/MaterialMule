import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

/** apps/api/migrations, resolved the same way from src/db and dist/db. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant so concurrent migrators on one database queue instead of racing.
const ADVISORY_LOCK_KEY = 726_150_002;

/**
 * The first migration of the pre-release lineage that 0001_baseline replaced (MM-AO02, owner
 * decision 2026-10-29). A database that recorded it was never deployed; it is refused instead of
 * being upgraded, and only an explicitly designated disposable database is rebuilt.
 */
const RETIRED_LINEAGE = { version: '0001', name: 'initial_schema' };
export const RETIRED_LINEAGE_MESSAGE =
  'This database was built from the retired pre-release migration lineage (0001_initial_schema to ' +
  '0078), which 0001_baseline replaced. It cannot be upgraded. If it is a disposable development ' +
  'or test database, rebuild it (npm run db:rebuild:dev -- --disposable <database> or ' +
  'npm run db:reset:test); otherwise export what you need first. See docs/database.md.';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export async function readMigrations(directory = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(`Migration file name "${file}" must look like 0001_snake_name.sql`);
    }
    const sql = await readFile(`${directory}/${file}`, 'utf8');
    migrations.push({
      version: match[1]!,
      name: match[2]!,
      sql,
      // Line endings are normalised so a Windows checkout and CI hash identically.
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    });
  }
  const versions = migrations.map((m) => m.version);
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) {
    throw new MigrationError(`Two migrations share version ${duplicate}`);
  }
  return migrations;
}

/**
 * Applies pending migrations in version order, each in its own transaction. Refuses to run if an
 * applied migration's file was edited afterwards (forward-only: write a new migration instead).
 */
export async function migrate(pool: Pool, migrations?: MigrationFile[]): Promise<MigrateResult> {
  const files = migrations ?? (await readMigrations());
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migration (
          version     text PRIMARY KEY,
          name        text NOT NULL,
          checksum    text NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migration',
      );
      if (
        rows.some(
          (row) => row.version === RETIRED_LINEAGE.version && row.name === RETIRED_LINEAGE.name,
        )
      ) {
        throw new MigrationError(RETIRED_LINEAGE_MESSAGE);
      }
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));

      for (const [version, checksum] of applied) {
        const file = files.find((m) => m.version === version);
        if (!file) {
          throw new MigrationError(
            `Database has migration ${version} but no matching file exists. Is this checkout older than the database?`,
          );
        }
        if (file.checksum !== checksum) {
          throw new MigrationError(
            `Migration ${version}_${file.name} was edited after it was applied. Revert the edit and add a new migration instead.`,
          );
        }
      }

      const result: MigrateResult = { applied: [], alreadyApplied: [...applied.keys()].sort() };
      for (const migration of files) {
        if (applied.has(migration.version)) {
          continue;
        }
        await applyOne(client, migration);
        result.applied.push(`${migration.version}_${migration.name}`);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyOne(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migration (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new MigrationError(
      `Migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`,
    );
  }
}
