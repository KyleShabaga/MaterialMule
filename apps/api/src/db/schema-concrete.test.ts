import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C01 (migration 0015): concrete report / set / specimen roots, proven in the database.
// Fictional data only (DEMO- projects, invented people, TMP-D07 device code).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const FK = { code: PG.foreignKeyViolation };
const UNIQUE = { code: PG.uniqueViolation };

async function report(
  pool: Pool,
  projectId: string,
  by: string,
  fields: Record<string, unknown> = {},
) {
  const columns = ['project_id', 'created_by_user_id', ...Object.keys(fields)];
  const values = [projectId, by, ...Object.values(fields)];
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO concrete_field_report (${columns.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    values,
  );
  return rows[0]!.id;
}

async function set(
  pool: Pool,
  projectId: string,
  reportId: string,
  ids: { temporary?: string; permanent?: string; number?: number } = {},
) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO concrete_specimen_set (project_id, field_report_id, temporary_id, permanent_id,
                                        permanent_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [projectId, reportId, ids.temporary ?? null, ids.permanent ?? null, ids.number ?? null],
  );
  return rows[0]!.id;
}

async function specimen(pool: Pool, projectId: string, setId: string, letter: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO concrete_specimen (project_id, set_id, letter) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, setId, letter],
  );
  return rows[0]!.id;
}

describe.runIf(testDatabaseUrl)('concrete domain roots (MM-V2-C01, migration 0015)', () => {
  let db: TestSchema;
  let tech: string;
  let lead: string;
  let lab: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    lead = await insertUser(db.pool, 'PE');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
    );
    lab = rows[0]!.id;
    projectA = await insertProject(db.pool, 'DEMO-2601', lead);
    projectB = await insertProject(db.pool, 'DEMO-2602', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('AC3: an incomplete draft is valid and consumes nothing', () => {
    it('stores a report with no technician, no sets, no specimens and no numbers', async () => {
      const id = await report(db.pool, projectA, lab);
      const { rows } = await db.pool.query(
        `SELECT workflow_state, technician_user_id, ready_to_submit_at, submitted_at, issue_count,
                last_issued_version, version
         FROM concrete_field_report WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        workflow_state: 'draft',
        technician_user_id: null,
        ready_to_submit_at: null,
        submitted_at: null,
        issue_count: 0,
        last_issued_version: null,
        version: 1,
      });
      const sets = await db.pool.query(
        'SELECT count(*)::int AS n FROM concrete_specimen_set WHERE field_report_id = $1',
        [id],
      );
      expect(sets.rows[0].n).toBe(0);
    });

    it('stores a set with no temporary or permanent ID, and specimens without numbers', async () => {
      const r = await report(db.pool, projectA, tech, { technician_user_id: tech });
      const s = await set(db.pool, projectA, r);
      await specimen(db.pool, projectA, s, 'A');
      const { rows } = await db.pool.query(
        'SELECT temporary_id, permanent_id FROM concrete_specimen_identity WHERE set_id = $1',
        [s],
      );
      expect(rows).toEqual([{ temporary_id: null, permanent_id: null }]);
    });

    it('never touches storage-unit counters', async () => {
      const { rows } = await db.pool.query(
        'SELECT count(*)::int AS n FROM storage_unit_annual_counter',
      );
      expect(rows[0].n).toBe(0);
    });

    it('accepts a client-generated UUID, so a retried sync names the same row', async () => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO concrete_field_report (id, project_id, created_by_user_id) VALUES ($1, $2, $3)`,
        [id, projectA, tech],
      );
      const retry = await db.pool.query(
        `INSERT INTO concrete_field_report (id, project_id, created_by_user_id) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, projectA, tech],
      );
      expect(retry.rowCount).toBe(0);
    });
  });

  describe('AC2: children must share their parent project', () => {
    it('refuses a set in another project than its report', async () => {
      const r = await report(db.pool, projectA, tech);
      await expect(set(db.pool, projectB, r)).rejects.toMatchObject(FK);
    });

    it('refuses a specimen in another project than its set', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r);
      await expect(specimen(db.pool, projectB, s, 'A')).rejects.toMatchObject(FK);
    });

    it('refuses a set whose report does not exist', async () => {
      await expect(set(db.pool, projectA, randomUUID())).rejects.toMatchObject(FK);
    });

    it('carries an unnumbered report project correction down to sets and specimens', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r, { temporary: 'TMP-D07-101' });
      const sp = await specimen(db.pool, projectA, s, 'A');
      await db.pool.query('UPDATE concrete_field_report SET project_id = $2 WHERE id = $1', [
        r,
        projectB,
      ]);
      const { rows } = await db.pool.query(
        `SELECT s.project_id AS set_project, sp.project_id AS specimen_project
         FROM concrete_specimen sp JOIN concrete_specimen_set s ON s.id = sp.set_id
         WHERE sp.id = $1`,
        [sp],
      );
      expect(rows[0]).toEqual({ set_project: projectB, specimen_project: projectB });
    });

    it('refuses moving a set or specimen to another project on its own', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r);
      const sp = await specimen(db.pool, projectA, s, 'A');
      await expect(
        db.pool.query('UPDATE concrete_specimen_set SET project_id = $2 WHERE id = $1', [
          s,
          projectB,
        ]),
      ).rejects.toMatchObject(FK);
      await expect(
        db.pool.query('UPDATE concrete_specimen SET project_id = $2 WHERE id = $1', [sp, projectB]),
      ).rejects.toMatchObject(FK);
    });

    it('refuses a project correction once a set holds a permanent number', async () => {
      const r = await report(db.pool, projectA, tech);
      await set(db.pool, projectA, r, { permanent: '26-40', number: 40 });
      await expect(
        db.pool.query('UPDATE concrete_field_report SET project_id = $2 WHERE id = $1', [
          r,
          projectB,
        ]),
      ).rejects.toMatchObject(RESTRICT);
    });
  });

  describe('AC4: aliases attach without changing internal UUIDs', () => {
    it('attaches a temporary then a permanent ID; every UUID stays and specimens derive both', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r);
      const a = await specimen(db.pool, projectA, s, 'A');
      const b = await specimen(db.pool, projectA, s, 'B');
      await db.pool.query(
        `UPDATE concrete_specimen_set SET temporary_id = 'TMP-D07-001' WHERE id = $1`,
        [s],
      );
      await db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_id = '27-03', permanent_number = 3 WHERE id = $1`,
        [s],
      );
      const { rows } = await db.pool.query(
        `SELECT i.specimen_id, i.set_id, s.field_report_id, i.temporary_id, i.permanent_id
         FROM concrete_specimen_identity i JOIN concrete_specimen_set s ON s.id = i.set_id
         WHERE i.set_id = $1 ORDER BY i.letter`,
        [s],
      );
      expect(rows).toEqual([
        {
          specimen_id: a,
          set_id: s,
          field_report_id: r,
          temporary_id: 'TMP-D07-001A',
          permanent_id: '27-03A',
        },
        {
          specimen_id: b,
          set_id: s,
          field_report_id: r,
          temporary_id: 'TMP-D07-001B',
          permanent_id: '27-03B',
        },
      ]);
    });

    it('refuses changing any internal UUID', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r);
      const sp = await specimen(db.pool, projectA, s, 'A');
      for (const [table, id] of [
        ['concrete_field_report', r],
        ['concrete_specimen_set', s],
        ['concrete_specimen', sp],
      ] as const) {
        await expect(
          db.pool.query(`UPDATE ${table} SET id = gen_random_uuid() WHERE id = $1`, [id]),
        ).rejects.toMatchObject(RESTRICT);
      }
    });

    it('keeps an attached temporary ID and permanent number fixed', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r, {
        temporary: 'TMP-D07-002',
        permanent: '27-04',
        number: 4,
      });
      for (const change of [
        `temporary_id = 'TMP-D07-003'`,
        'temporary_id = NULL',
        `permanent_id = '27-05', permanent_number = 5`,
        'permanent_id = NULL, permanent_number = NULL',
        `permanent_id = 'G27-04'`,
      ]) {
        await expect(
          db.pool.query(`UPDATE concrete_specimen_set SET ${change} WHERE id = $1`, [s]),
        ).rejects.toMatchObject(RESTRICT);
      }
    });

    it('refuses moving a set to another report or a specimen to another set', async () => {
      const r1 = await report(db.pool, projectA, tech);
      const r2 = await report(db.pool, projectA, tech);
      const s1 = await set(db.pool, projectA, r1);
      const s2 = await set(db.pool, projectA, r2);
      const sp = await specimen(db.pool, projectA, s1, 'A');
      await expect(
        db.pool.query('UPDATE concrete_specimen_set SET field_report_id = $2 WHERE id = $1', [
          s1,
          r2,
        ]),
      ).rejects.toMatchObject(RESTRICT);
      await expect(
        db.pool.query('UPDATE concrete_specimen SET set_id = $2 WHERE id = $1', [sp, s2]),
      ).rejects.toMatchObject(RESTRICT);
    });
  });

  describe('identity formats and uniqueness', () => {
    it('accepts the documented ID shapes and refuses others', async () => {
      const r = await report(db.pool, projectA, tech);
      await set(db.pool, projectA, r, { temporary: 'TMP-D12-045' });
      await set(db.pool, projectA, r, { permanent: 'G27-07', number: 7 });
      await set(db.pool, projectA, r, { permanent: '27-123', number: 123 });
      for (const bad of ['D07-001', 'TMP-d07-001', 'TMP-D07-001A', 'TMP--001']) {
        await expect(set(db.pool, projectA, r, { temporary: bad })).rejects.toMatchObject(REJECT);
      }
      for (const [permanent, number] of [
        ['27-3', 3],
        ['27-003', 3],
        ['27-08', 9],
        ['X27-08', 8],
        ['2027-08', 8],
      ] as const) {
        await expect(set(db.pool, projectA, r, { permanent, number })).rejects.toMatchObject(
          REJECT,
        );
      }
      await expect(set(db.pool, projectA, r, { permanent: '27-30' })).rejects.toMatchObject(REJECT);
      await expect(set(db.pool, projectA, r, { number: 30 })).rejects.toMatchObject(REJECT);
    });

    it('uses a permanent number once per project, across years and grout prefix', async () => {
      const r = await report(db.pool, projectA, tech);
      await set(db.pool, projectA, r, { permanent: '26-11', number: 11 });
      await expect(
        set(db.pool, projectA, r, { permanent: '27-11', number: 11 }),
      ).rejects.toMatchObject(UNIQUE);
      await expect(
        set(db.pool, projectA, r, { permanent: 'G26-11', number: 11 }),
      ).rejects.toMatchObject(UNIQUE);
      // Set numbers repeat across projects (spec page 3).
      const other = await report(db.pool, projectB, tech);
      await set(db.pool, projectB, other, { permanent: '26-11', number: 11 });
    });

    it('uses a temporary ID once everywhere', async () => {
      const r = await report(db.pool, projectA, tech);
      const other = await report(db.pool, projectB, tech);
      await set(db.pool, projectA, r, { temporary: 'TMP-D07-500' });
      await expect(
        set(db.pool, projectB, other, { temporary: 'TMP-D07-500' }),
      ).rejects.toMatchObject(UNIQUE);
    });

    it('letters specimens A–Z once per set: at most 26', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r);
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        await specimen(db.pool, projectA, s, letter);
      await expect(specimen(db.pool, projectA, s, 'A')).rejects.toMatchObject(UNIQUE);
      for (const bad of ['a', 'AA', '1', '']) {
        await expect(specimen(db.pool, projectA, s, bad)).rejects.toMatchObject(REJECT);
      }
    });

    it('allows re-lettering before a set is numbered, never after', async () => {
      const r = await report(db.pool, projectA, tech);
      const s = await set(db.pool, projectA, r, { temporary: 'TMP-D07-600' });
      const sp = await specimen(db.pool, projectA, s, 'B');
      await db.pool.query(`UPDATE concrete_specimen SET letter = 'A' WHERE id = $1`, [sp]);
      await db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_id = '27-60', permanent_number = 60 WHERE id = $1`,
        [s],
      );
      await expect(
        db.pool.query(`UPDATE concrete_specimen SET letter = 'C' WHERE id = $1`, [sp]),
      ).rejects.toMatchObject(RESTRICT);
    });
  });

  describe('numbers stay in the register', () => {
    it('deletes an unnumbered draft set and its specimens, never a numbered one', async () => {
      const r = await report(db.pool, projectA, tech);
      const draft = await set(db.pool, projectA, r, { temporary: 'TMP-D07-700' });
      await specimen(db.pool, projectA, draft, 'A');
      await db.pool.query('DELETE FROM concrete_specimen WHERE set_id = $1', [draft]);
      await db.pool.query('DELETE FROM concrete_specimen_set WHERE id = $1', [draft]);

      const numbered = await set(db.pool, projectA, r, { permanent: '27-70', number: 70 });
      await specimen(db.pool, projectA, numbered, 'A');
      await expect(
        db.pool.query('DELETE FROM concrete_specimen WHERE set_id = $1', [numbered]),
      ).rejects.toMatchObject(RESTRICT);
      await expect(
        db.pool.query('DELETE FROM concrete_specimen_set WHERE id = $1', [numbered]),
      ).rejects.toMatchObject(RESTRICT);
      await expect(
        db.pool.query('DELETE FROM concrete_field_report WHERE id = $1', [r]),
      ).rejects.toMatchObject(FK);
    });

    it('refuses TRUNCATE of sets and specimens', async () => {
      await expect(db.pool.query('TRUNCATE concrete_specimen')).rejects.toMatchObject(RESTRICT);
      await expect(db.pool.query('TRUNCATE concrete_specimen_set CASCADE')).rejects.toMatchObject(
        RESTRICT,
      );
    });
  });

  describe('separate status dimensions on the report', () => {
    it('needs the intent time for Ready to submit and a submission time exactly when submitted', async () => {
      await expect(
        report(db.pool, projectA, tech, { workflow_state: 'ready_to_submit' }),
      ).rejects.toMatchObject(REJECT);
      await report(db.pool, projectA, tech, {
        workflow_state: 'ready_to_submit',
        ready_to_submit_at: '2026-11-07T15:00:00Z',
      });
      for (const state of ['submitted', 'returned', 'reviewed']) {
        await expect(
          report(db.pool, projectA, tech, { workflow_state: state }),
        ).rejects.toMatchObject(REJECT);
        await report(db.pool, projectA, tech, {
          workflow_state: state,
          submitted_at: '2026-11-07T16:00:00Z',
        });
      }
      await expect(
        report(db.pool, projectA, tech, {
          workflow_state: 'draft',
          submitted_at: '2026-11-07T16:00:00Z',
        }),
      ).rejects.toMatchObject(REJECT);
      await report(db.pool, projectA, tech, { workflow_state: 'void' });
    });

    it('refuses workflow values that belong to other dimensions', async () => {
      for (const state of ['issued', 'revised', 'accepted', 'complete', 'pending_upload']) {
        await expect(
          report(db.pool, projectA, tech, { workflow_state: state }),
        ).rejects.toMatchObject(REJECT);
      }
    });

    it('records issuance apart from workflow: all latest-issue fields or none, of an existing version', async () => {
      const issued = {
        workflow_state: 'reviewed',
        submitted_at: '2026-11-07T16:00:00Z',
        issue_count: 1,
        last_issued_version: 1,
        last_issued_at: '2026-11-07T17:00:00Z',
        last_issued_by_user_id: lead,
      };
      await report(db.pool, projectA, tech, issued);
      await expect(
        report(db.pool, projectA, tech, { ...issued, last_issued_version: 2 }),
      ).rejects.toMatchObject(REJECT);
      await expect(
        report(db.pool, projectA, tech, { ...issued, last_issued_at: null }),
      ).rejects.toMatchObject(REJECT);
      await expect(
        report(db.pool, projectA, tech, { ...issued, issue_count: 0 }),
      ).rejects.toMatchObject(REJECT);
      await expect(report(db.pool, projectA, tech, { issue_count: -1 })).rejects.toMatchObject(
        REJECT,
      );
    });
  });

  describe('staff attribution', () => {
    it('credits field work to an active person, never a shared or disabled account', async () => {
      await expect(
        report(db.pool, projectA, lab, { technician_user_id: lab }),
      ).rejects.toMatchObject(REJECT);
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
         VALUES ('Former Tech', 'FT', 'personal', 'disabled') RETURNING id`,
      );
      await expect(
        report(db.pool, projectA, tech, { technician_user_id: rows[0]!.id }),
      ).rejects.toMatchObject(REJECT);
      // The shared account may hold the authority (created_by) while a person is credited.
      await report(db.pool, projectA, lab, { technician_user_id: tech });
    });

    it('keeps the credit when the technician is later disabled', async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
         VALUES ('Leaving Tech', 'LT', 'personal', 'active') RETURNING id`,
      );
      const r = await report(db.pool, projectA, tech, { technician_user_id: rows[0]!.id });
      await db.pool.query(
        `UPDATE app_user SET status = 'disabled', disabled_reason = 'Fictional' WHERE id = $1`,
        [rows[0]!.id],
      );
      await db.pool.query('UPDATE concrete_field_report SET version = version + 1 WHERE id = $1', [
        r,
      ]);
    });

    it('refuses an unknown creator or project', async () => {
      await expect(report(db.pool, projectA, randomUUID())).rejects.toMatchObject(FK);
      await expect(report(db.pool, randomUUID(), tech)).rejects.toMatchObject(FK);
    });
  });
});

// AC1 / T3: applying 0015 to a populated database changes no existing row.
describe.runIf(testDatabaseUrl)(
  'migration 0015 on a populated database',
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

    it('keeps projects, receipts, storage IDs, counters and histories unchanged', async () => {
      db = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0015'),
      );
      await runSeed(db.pool, 'reference', 'test');
      await runSeed(db.pool, 'dev', 'test');
      await db.pool.query(
        `INSERT INTO storage_unit_annual_counter (prefix, year, last_value) VALUES ('BKT', 2026, 14) ON CONFLICT DO NOTHING`,
      );
      await db.pool.query(
        `INSERT INTO audit_event (action, entity_type, entity_id, actor_user_id, actor_account_type,
                                actor_name_snapshot)
       VALUES ('project.updated', 'project', '00000000-0000-4000-8000-000000000201',
               '00000000-0000-4000-8000-000000000101', 'test', 'Pat Example')`,
      );
      const before = await snapshot(db.pool);
      expect(before.storage_unit!.length).toBeGreaterThan(0);
      expect(before.receipt!.length).toBeGreaterThan(0);

      expect(
        (
          await migrate(
            db.pool,
            all.filter((m) => m.version < '0016'),
          )
        ).applied,
      ).toEqual(['0015_concrete_domain']);

      const after = await snapshot(db.pool);
      for (const table of ['concrete_field_report', 'concrete_specimen_set', 'concrete_specimen']) {
        expect(after[table]).toEqual([]);
        delete after[table];
      }
      expect(after).toEqual(before);
    });
  },
);
