import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONCRETE_SETTINGS_DEFAULTS } from '@materialmule/shared';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C02 (migration 0016): per-project concrete settings and the concrete Lab Manager grant
// (D13), proven in the database. Fictional data only (DEMO- projects, invented people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

describe.runIf(testDatabaseUrl)('concrete project settings (MM-V2-C02, migration 0016)', () => {
  let db: TestSchema;
  let lead: string;
  let labManager: string;
  let engineer: string;
  let lab: string;
  let projectId: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await insertUser(db.pool, 'PE');
    labManager = await insertUser(db.pool, 'LM');
    engineer = await insertUser(db.pool, 'DE');
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`, [
      labManager,
    ]);
    lab = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, account_type, status)
         VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
      )
    ).rows[0]!.id;
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`, [
      lab,
    ]);
    projectId = await insertProject(db.pool, 'DEMO-2601', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function settings(project: string, values: Record<string, unknown> = {}) {
    const columns = [
      'project_id',
      'updated_by_user_id',
      'updated_by_name_snapshot',
      ...Object.keys(values),
    ];
    const params = [project, lead, 'Test PE', ...Object.values(values)];
    await db.pool.query(
      `INSERT INTO concrete_project_settings (${columns.join(', ')})
       VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  }

  it('defaults equal the shared contract: 7/28/28/HOLD, 56 days, machine info not chosen', async () => {
    const project = await insertProject(db.pool, 'DEMO-2602', lead);
    await settings(project);
    const { rows } = await db.pool.query(
      `SELECT default_specimen_ages, hold_duration_days, include_machine_info, version
       FROM concrete_project_settings WHERE project_id = $1`,
      [project],
    );
    expect(rows[0]).toEqual({
      default_specimen_ages: CONCRETE_SETTINGS_DEFAULTS.defaultSpecimenAges.map(String),
      hold_duration_days: CONCRETE_SETTINGS_DEFAULTS.holdDurationDays,
      include_machine_info: null,
      version: 1,
    });
  });

  it('accepts ages of 1–999 days or HOLD, 1–26 of them; refuses anything else', async () => {
    const ok = await insertProject(db.pool, 'DEMO-2603', lead);
    await settings(ok, { default_specimen_ages: ['3', '7', '999', 'HOLD', 'HOLD'] });
    for (const ages of [
      [],
      ['0'],
      ['07'],
      ['1000'],
      ['hold'],
      ['-7'],
      ['7.5'],
      [null],
      Array.from({ length: 27 }, () => '28'),
    ]) {
      const project = await insertProject(db.pool, `DEMO-${randomUUID().slice(0, 8)}`, lead);
      await expect(settings(project, { default_specimen_ages: ages })).rejects.toMatchObject(
        REJECT,
      );
    }
    const nested = await insertProject(db.pool, 'DEMO-2604', lead);
    await expect(
      db.pool.query(
        `INSERT INTO concrete_project_settings (project_id, updated_by_user_id,
           updated_by_name_snapshot, default_specimen_ages)
         VALUES ($1, $2, 'Test PE', '{{7,28},{28,56}}')`,
        [nested, lead],
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('keeps the HOLD duration between 1 and 999 days', async () => {
    for (const days of [0, -1, 1000]) {
      const project = await insertProject(db.pool, `DEMO-${randomUUID().slice(0, 8)}`, lead);
      await expect(settings(project, { hold_duration_days: days })).rejects.toMatchObject(REJECT);
    }
  });

  it('one settings row per project; never deleted; project fixed; version steps by one', async () => {
    const project = await insertProject(db.pool, 'DEMO-2605', lead);
    const other = await insertProject(db.pool, 'DEMO-2606', lead);
    await settings(project);
    await expect(settings(project)).rejects.toMatchObject(UNIQUE);
    await expect(
      db.pool.query('DELETE FROM concrete_project_settings WHERE project_id = $1', [project]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query(
        'UPDATE concrete_project_settings SET project_id = $2, version = 2 WHERE project_id = $1',
        [project, other],
      ),
    ).rejects.toMatchObject(REJECT);
    for (const version of [1, 3]) {
      await expect(
        db.pool.query(
          `UPDATE concrete_project_settings SET hold_duration_days = 60, version = $2
           WHERE project_id = $1`,
          [project, version],
        ),
      ).rejects.toMatchObject(REJECT);
    }
    await db.pool.query(
      `UPDATE concrete_project_settings SET hold_duration_days = 60, version = version + 1
       WHERE project_id = $1`,
      [project],
    );
    const { rows } = await db.pool.query(
      'SELECT hold_duration_days, version FROM concrete_project_settings WHERE project_id = $1',
      [project],
    );
    expect(rows[0]).toEqual({ hold_duration_days: 60, version: 2 });
  });

  it('changing settings never touches existing concrete records (AC3)', async () => {
    const project = await insertProject(db.pool, 'DEMO-2607', lead);
    const { rows: report } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
       RETURNING id`,
      [project, lead],
    );
    const { rows: setRow } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2) RETURNING id`,
      [project, report[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age) VALUES ($1, $2, 'A', '7'), ($1, $2, 'B', '28')`,
      [project, setRow[0]!.id],
    );
    const snapshot = async () =>
      (
        await db.pool.query(
          `SELECT (SELECT json_agg(r ORDER BY r.id) FROM concrete_field_report r WHERE project_id = $1) AS reports,
                  (SELECT json_agg(s ORDER BY s.id) FROM concrete_specimen_set s WHERE project_id = $1) AS sets,
                  (SELECT json_agg(c ORDER BY c.id) FROM concrete_specimen c WHERE project_id = $1) AS specimens`,
          [project],
        )
      ).rows[0];
    const before = await snapshot();
    await settings(project);
    await db.pool.query(
      `UPDATE concrete_project_settings
       SET default_specimen_ages = '{3,7,28,HOLD}', hold_duration_days = 90,
           include_machine_info = true, version = version + 1
       WHERE project_id = $1`,
      [project],
    );
    expect(await snapshot()).toEqual(before);
  });

  describe('concrete Lab Manager grant (D13)', () => {
    const grant = (values: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        project_id: projectId,
        lab_manager_user_id: labManager,
        lab_manager_name_snapshot: 'Test LM',
        granted_by_user_id: lead,
        granted_by_name_snapshot: 'Test PE',
        grant_reason: 'Runs the concrete lab for this project',
        grant_idempotency_key: randomUUID(),
        grant_request_hash: 'h',
        ...values,
      };
      const keys = Object.keys(row);
      return db.pool
        .query<{ id: string }>(
          `INSERT INTO project_concrete_lab_manager_grant (${keys.join(', ')})
           VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(row),
        )
        .then((result) => result.rows[0]!.id);
    };
    // A function: `lead` is set in beforeAll, after this block is collected.
    const revocation = () => ({
      revoked_at: new Date(Date.now() + 1000).toISOString(),
      revoked_by_user_id: lead,
      revoked_by_name_snapshot: 'Test PE',
      revoke_reason: 'No longer on this project',
    });
    const revoke = (id: string, values: Record<string, unknown> = revocation()) => {
      const keys = Object.keys(values);
      return db.pool.query(
        `UPDATE project_concrete_lab_manager_grant
         SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...Object.values(values)],
      );
    };

    it('goes only to a personal Lab Manager; needs a reason', async () => {
      // No lab_manager role.
      await expect(grant({ lab_manager_user_id: engineer })).rejects.toMatchObject(REJECT);
      // The shared LAB account, even with the role assigned by mistake.
      await expect(grant({ lab_manager_user_id: lab })).rejects.toMatchObject(REJECT);
      await expect(grant({ grant_reason: '   ' })).rejects.toMatchObject(REJECT);
    });

    it('one active grant per project and person; revoked once with a reason, never deleted', async () => {
      const id = await grant();
      await expect(grant()).rejects.toMatchObject(UNIQUE);
      await expect(
        db.pool.query('DELETE FROM project_concrete_lab_manager_grant WHERE id = $1', [id]),
      ).rejects.toMatchObject(RESTRICT);
      // Only the ending columns may change; a reason is part of the ending.
      await expect(revoke(id, { grant_reason: 'Rewritten' })).rejects.toMatchObject(RESTRICT);
      await expect(revoke(id, { ...revocation(), revoke_reason: null })).rejects.toMatchObject(
        REJECT,
      );
      await revoke(id);
      await expect(revoke(id, { ...revocation(), revoke_reason: 'Again' })).rejects.toMatchObject(
        RESTRICT,
      );
      // A new grant after revocation is a new row; the old one stays.
      const again = await grant();
      expect(again).not.toBe(id);
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM project_concrete_lab_manager_grant
         WHERE project_id = $1 AND lab_manager_user_id = $2`,
        [projectId, labManager],
      );
      expect(rows[0]!.n).toBe(2);
    });
  });
});

// AC3 / T3: applying 0016 to a populated database changes no existing row.
describe.runIf(testDatabaseUrl)(
  'migration 0016 on a populated database',
  { timeout: 60_000 },
  () => {
    let db: TestSchema | undefined;

    afterEach(async () => {
      await db?.drop();
      db = undefined;
    });

    async function snapshot(pool: Pool): Promise<Record<string, unknown[]>> {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migration'
         ORDER BY table_name`,
      );
      const out: Record<string, unknown[]> = {};
      for (const { table_name } of tables) {
        const { rows } = await pool.query(
          `SELECT row_to_json(t)::text AS row FROM "${table_name}" t ORDER BY 1`,
        );
        out[table_name] = rows.map((r: { row: string }) => r.row);
      }
      return out;
    }

    it('adds empty tables and changes no project, concrete record or grant', async () => {
      db = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0016'),
      );
      await runSeed(db.pool, 'reference', 'test');
      await runSeed(db.pool, 'dev', 'test');
      const { rows: projects } = await db.pool.query<{ id: string }>(
        'SELECT id FROM project ORDER BY id LIMIT 1',
      );
      const { rows: users } = await db.pool.query<{ id: string }>(
        `SELECT id FROM app_user WHERE account_type <> 'shared_lab' ORDER BY id LIMIT 1`,
      );
      await db.pool.query(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)`,
        [projects[0]!.id, users[0]!.id],
      );
      const before = await snapshot(db.pool);

      expect(
        (
          await migrate(
            db.pool,
            all.filter((m) => m.version < '0017'),
          )
        ).applied,
      ).toEqual(['0016_concrete_project_settings']);

      const after = await snapshot(db.pool);
      for (const table of ['concrete_project_settings', 'project_concrete_lab_manager_grant']) {
        expect(after[table]).toEqual([]);
        delete after[table];
      }
      expect(after).toEqual(before);
    });
  },
);
