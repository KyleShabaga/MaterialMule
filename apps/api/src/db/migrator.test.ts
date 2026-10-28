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

  it('MM-T44: 0024 confirms admin-assigned initials only from audit evidence', async () => {
    db = await createTestSchema();
    const all = await readMigrations();
    const before0024 = all.filter((m) => m.version < '0024');
    expect(all.some((m) => m.version === '0024')).toBe(true);
    await migrate(db.pool, before0024);
    const pool = db.pool;

    const user = async (name: string, initials: string | null) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO app_user (display_name, official_initials, account_type, status)
           VALUES ($1, $2, 'personal', 'active') RETURNING id`,
          [name, initials],
        )
      ).rows[0]!.id;
    const event = (
      action: string,
      entityId: string,
      actorId: string | null,
      initials: string,
      at: string,
      accountType = 'personal',
    ) =>
      pool.query(
        `INSERT INTO audit_event (occurred_at, action, entity_type, entity_id, actor_user_id,
                                  actor_account_type, after_values)
         VALUES ($1, $2, 'app_user', $3, $4, $5, $6)`,
        [at, action, entityId, actorId, accountType, { officialInitials: initials }],
      );
    const adminA = await user('Avery Admin', 'AA');
    const adminB = await user('Blake Admin', 'BA');
    // Pre-provisioned by A: confirmed by A at the event time.
    const preprovisioned = await user('Review New Staff', 'RS');
    await event('staff.preprovisioned', preprovisioned, adminA, 'RS', '2026-10-01T15:00:00Z');
    // Assigned by A, then changed by B: B's change is the evidence.
    const changed = await user('Casey Changed', 'CC');
    await event('staff.preprovisioned', changed, adminA, 'CX', '2026-10-01T15:00:00Z');
    await event('staff.initials_changed', changed, adminB, 'CC', '2026-10-02T15:00:00Z');
    // The value on record differs from the latest audited one: no trustworthy evidence.
    const drifted = await user('Drew Drifted', 'DZ');
    await event('staff.initials_changed', drifted, adminA, 'DD', '2026-10-01T15:00:00Z');
    // A system actor is not a confirming person.
    const systemSet = await user('Sam System', 'SS');
    await event('staff.initials_changed', systemSet, null, 'SS', '2026-10-01T15:00:00Z', 'system');
    // Seeded or otherwise unaudited initials stay unconfirmed.
    const seeded = await user('Sid Seeded', 'SD');
    // An existing confirmation is kept as it is.
    const alreadyConfirmed = await user('Kim Kept', 'KK');
    await pool.query(
      `UPDATE app_user SET initials_confirmed_by_user_id = $2,
              initials_confirmed_at = '2026-09-01T15:00:00Z' WHERE id = $1`,
      [alreadyConfirmed, adminB],
    );
    await event('staff.preprovisioned', alreadyConfirmed, adminA, 'KK', '2026-10-01T15:00:00Z');

    const result = await migrate(db.pool, all);
    expect(result.applied).toContain('0024_staff_initials_confirmation_backfill');

    const { rows } = await pool.query<{
      id: string;
      by: string | null;
      at: Date | null;
    }>(
      `SELECT id, initials_confirmed_by_user_id AS by, initials_confirmed_at AS at
       FROM app_user WHERE id = ANY($1::uuid[])`,
      [[preprovisioned, changed, drifted, systemSet, seeded, alreadyConfirmed]],
    );
    const byId = new Map(rows.map((row) => [row.id, { by: row.by, at: row.at?.toISOString() }]));
    expect(byId.get(preprovisioned)).toEqual({ by: adminA, at: '2026-10-01T15:00:00.000Z' });
    expect(byId.get(changed)).toEqual({ by: adminB, at: '2026-10-02T15:00:00.000Z' });
    expect(byId.get(drifted)).toEqual({ by: null, at: undefined });
    expect(byId.get(systemSet)).toEqual({ by: null, at: undefined });
    expect(byId.get(seeded)).toEqual({ by: null, at: undefined });
    expect(byId.get(alreadyConfirmed)).toEqual({ by: adminB, at: '2026-09-01T15:00:00.000Z' });
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
