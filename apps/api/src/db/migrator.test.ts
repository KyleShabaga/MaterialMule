import { afterEach, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { insertProject, insertUser } from '../test-support/fixtures.js';
import {
  MigrationError,
  RETIRED_LINEAGE_MESSAGE,
  migrate,
  readMigrations,
  type MigrationFile,
} from './migrator.js';
import { SeedRefusedError, runSeed } from './seed.js';

function extraMigration(version: string, sql: string): MigrationFile {
  return { version, name: 'test_only', sql, checksum: `checksum-${version}-${sql.length}` };
}

describe('readMigrations', () => {
  it('reads the repository migrations in version order with stable checksums', async () => {
    const files = await readMigrations();
    expect(files[0]).toMatchObject({ version: '0001', name: 'baseline' });
    const versions = files.map((f) => f.version);
    expect(versions).toEqual([...versions].sort());
    const again = await readMigrations();
    expect(again.map((f) => f.checksum)).toEqual(files.map((f) => f.checksum));
  });
});

// Each test applies every migration to a fresh schema; under the full parallel suite that can
// pass the 5 s default on this PC, so allow 30 s as the permission-matrix sweep does.
describe.runIf(testDatabaseUrl)('migrate', { timeout: 30_000 }, () => {
  let db: TestSchema | undefined;

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it('applies everything once and is a no-op the second time', async () => {
    db = await createTestSchema();
    const first = await migrate(db.pool);
    expect(first.applied).toEqual([
      '0001_baseline',
      '0002_project_access',
      '0003_project_lead_appointment',
      '0004_action_item_rerouting',
      '0005_sample_tag_rules',
      '0006_disposed_unit_contents_final',
      '0007_disposed_unit_summary_guard_locks',
      '0008_unit_source_corrections',
      '0009_inherited_grant_review',
      '0010_lead_confirm_reason_optional',
      '0011_team_join_request',
    ]);
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

  it('MM-AO02: refuses a database built from the retired pre-release lineage', async () => {
    db = await createTestSchema();
    // What the retired lineage recorded first; its tables don't matter, the record does.
    await db.pool.query(`
      CREATE TABLE schema_migration (
        version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now())`);
    await db.pool.query(
      `INSERT INTO schema_migration (version, name, checksum) VALUES ('0001', 'initial_schema', 'x')`,
    );
    await expect(migrate(db.pool)).rejects.toThrowError(RETIRED_LINEAGE_MESSAGE);
    const { rows } = await db.pool.query(
      `SELECT to_regclass('project') AS project, count(*)::int AS recorded FROM schema_migration`,
    );
    expect(rows[0]).toEqual({ project: null, recorded: 1 });
  });

  it('AC7: production seed loads Receiving lab and LAB only and refuses dev fixtures', async () => {
    db = await createTestSchema();
    await migrate(db.pool);
    await runSeed(db.pool, 'reference', 'production');
    await runSeed(db.pool, 'reference', 'production');
    await expect(runSeed(db.pool, 'dev', 'production')).rejects.toBeInstanceOf(SeedRefusedError);
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*)::int FROM project) AS projects,
              (SELECT count(*)::int FROM app_user WHERE account_type <> 'shared_lab') AS people,
              (SELECT count(*)::int FROM app_user WHERE account_type = 'shared_lab') AS lab,
              (SELECT count(*)::int FROM local_credential) AS passwords,
              (SELECT count(*)::int FROM location) AS locations`,
    );
    // MM-T06: the shared LAB account exists, but with no password until an admin sets one.
    expect(rows[0]).toEqual({ projects: 0, people: 0, lab: 1, passwords: 0, locations: 1 });
  });

  it('loads development fixtures idempotently', async () => {
    db = await createTestSchema();
    await migrate(db.pool);
    await runSeed(db.pool, 'dev', 'test');
    await runSeed(db.pool, 'dev', 'test');
    const { rows } = await db.pool.query(
      `SELECT project_number, (SELECT count(*)::int FROM test_hole) AS holes FROM project
       ORDER BY project_number`,
    );
    expect(rows).toEqual([
      { project_number: 'DEMO-2601', holes: 3 },
      { project_number: 'DEMO-2602', holes: 3 },
    ]);
    // Inventory demo units (MM-T12), with their search documents.
    const units = await db.pool.query(
      `SELECT count(*)::int AS units, (SELECT count(*)::int FROM storage_unit_search) AS indexed
       FROM storage_unit`,
    );
    expect(units.rows[0]).toEqual({ units: 5, indexed: 5 });
  });
});
