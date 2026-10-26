import { afterEach, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { insertProject, insertUser } from '../test-support/fixtures.js';
import { MigrationError, migrate, readMigrations, type MigrationFile } from './migrator.js';
import { SeedRefusedError, runSeed } from './seed.js';

function extraMigration(version: string, sql: string): MigrationFile {
  return { version, name: 'test_only', sql, checksum: `checksum-${version}-${sql.length}` };
}

describe('readMigrations', () => {
  it('reads the repository migrations in version order with stable checksums', async () => {
    const files = await readMigrations();
    expect(files[0]).toMatchObject({ version: '0001', name: 'initial_schema' });
    const versions = files.map((f) => f.version);
    expect(versions).toEqual([...versions].sort());
    const again = await readMigrations();
    expect(again.map((f) => f.checksum)).toEqual(files.map((f) => f.checksum));
  });
});

describe.runIf(testDatabaseUrl)('migrate', () => {
  let db: TestSchema | undefined;

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it('applies everything once and is a no-op the second time', async () => {
    db = await createTestSchema();
    const first = await migrate(db.pool);
    expect(first.applied).toContain('0001_initial_schema');
    const second = await migrate(db.pool);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain('0001');
  });

  it('AC6: a follow-up migration keeps existing rows unchanged', async () => {
    db = await createTestSchema();
    const base = await readMigrations();
    await migrate(db.pool, base);
    const userId = await insertUser(db.pool, 'PE');
    const projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    const before = await db.pool.query('SELECT * FROM project WHERE id = $1', [projectId]);

    const result = await migrate(db.pool, [
      ...base,
      extraMigration('9001', 'ALTER TABLE project ADD COLUMN test_only_note text'),
    ]);

    expect(result.applied).toEqual(['9001_test_only']);
    const after = await db.pool.query('SELECT * FROM project WHERE id = $1', [projectId]);
    expect(after.rows[0]).toEqual({ ...before.rows[0], test_only_note: null });
  });

  it('refuses to run when an applied migration was edited', async () => {
    db = await createTestSchema();
    const base = await readMigrations();
    await migrate(db.pool, base);
    const edited = base.map((m, i) => (i === 0 ? { ...m, checksum: 'edited' } : m));
    await expect(migrate(db.pool, edited)).rejects.toThrowError(/edited after it was applied/);
  });

  it('rolls back a failing migration completely', async () => {
    db = await createTestSchema();
    const base = await readMigrations();
    await migrate(db.pool, base);
    await expect(
      migrate(db.pool, [
        ...base,
        extraMigration('9002', 'CREATE TABLE half_done (id int); SELECT broken_syntax FROM;'),
      ]),
    ).rejects.toBeInstanceOf(MigrationError);
    const { rows } = await db.pool.query(
      `SELECT to_regclass('half_done') AS table_exists,
              (SELECT count(*)::int FROM schema_migration WHERE version = '9002') AS recorded`,
    );
    expect(rows[0]).toEqual({ table_exists: null, recorded: 0 });
  });

  it('AC7: production seed loads Receiving lab only and refuses dev fixtures', async () => {
    db = await createTestSchema();
    await migrate(db.pool);
    await runSeed(db.pool, 'reference', 'production');
    await expect(runSeed(db.pool, 'dev', 'production')).rejects.toBeInstanceOf(SeedRefusedError);
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*)::int FROM project) AS projects,
              (SELECT count(*)::int FROM app_user) AS users,
              (SELECT count(*)::int FROM location) AS locations`,
    );
    expect(rows[0]).toEqual({ projects: 0, users: 0, locations: 1 });
  });

  it('loads development fixtures idempotently', async () => {
    db = await createTestSchema();
    await migrate(db.pool);
    await runSeed(db.pool, 'dev', 'test');
    await runSeed(db.pool, 'dev', 'test');
    const { rows } = await db.pool.query(
      `SELECT project_number, (SELECT count(*)::int FROM test_hole) AS holes FROM project`,
    );
    expect(rows).toEqual([{ project_number: 'DEMO-2601', holes: 2 }]);
  });
});
