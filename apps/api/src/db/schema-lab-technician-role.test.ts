import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertProject, insertUser, PG } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// MM-V2-C36 (migration 0024): the Lab Technician role. The role check takes admin, lab_manager
// and lab_technician; a Lab Technician is never a Lab Manager to the SQL rules (concrete grant,
// action-item routing). Fictional people only.
describe.runIf(testDatabaseUrl)(
  'Lab Technician role (MM-V2-C36, migration 0024)',
  { timeout: 30_000 },
  () => {
    let db: TestSchema;

    beforeAll(async () => {
      db = await createMigratedSchema();
    });
    afterAll(async () => {
      await db?.drop();
    });

    const assign = (userId: string, role: string) =>
      db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [userId, role]);

    it('the role check allows exactly admin, lab_manager and lab_technician', async () => {
      const person = await insertUser(db.pool, 'TB');
      for (const role of ['admin', 'lab_manager', 'lab_technician']) {
        await assign(person, role);
      }
      for (const role of ['technician', 'lab_tech', 'Lab Technician', 'reviewer', '']) {
        await expect(assign(person, role), role).rejects.toMatchObject({
          code: PG.checkViolation,
        });
      }
    });

    it('a Lab Technician cannot receive a project concrete Lab Manager grant', async () => {
      const lead = await insertUser(db.pool, 'PE');
      const project = await insertProject(db.pool, 'DEMO-2601', lead);
      const tech = await insertUser(db.pool, 'LT');
      await assign(tech, 'lab_technician');
      await expect(
        db.pool.query(
          `INSERT INTO project_concrete_lab_manager_grant
             (project_id, lab_manager_user_id, lab_manager_name_snapshot, granted_by_user_id,
              granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
           VALUES ($1, $2, 'Test LT', $3, 'Test PE', 'fictional', gen_random_uuid(), 'h')`,
          [project, tech, lead],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('action items can never target the Lab Technician role', async () => {
      const { rows } = await db.pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'action_item'::regclass AND conname = 'action_item_target_role_check'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toContain('lab_manager');
      expect(rows[0]!.def).not.toContain('lab_technician');
    });

    it('an upgrade keeps every existing role assignment', async () => {
      const fresh = await createTestSchema();
      try {
        const all = await readMigrations();
        await migrate(
          fresh.pool,
          all.filter((m) => m.version < '0024'),
        );
        const admin = await insertUser(fresh.pool, 'ADM');
        const lm = await insertUser(fresh.pool, 'LM');
        await fresh.pool.query(
          `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin'), ($2, 'lab_manager')`,
          [admin, lm],
        );
        const before = await fresh.pool.query(
          'SELECT user_id, role, granted_at FROM role_assignment ORDER BY user_id, role',
        );
        await expect(
          fresh.pool.query(
            `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
            [lm],
          ),
        ).rejects.toMatchObject({ code: PG.checkViolation });
        const result = await migrate(
          fresh.pool,
          all.filter((m) => m.version <= '0024'),
        );
        expect(result.applied).toContain('0024_lab_technician_role');
        const after = await fresh.pool.query(
          'SELECT user_id, role, granted_at FROM role_assignment ORDER BY user_id, role',
        );
        expect(after.rows).toEqual(before.rows);
        await fresh.pool.query(
          `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
          [lm],
        );
      } finally {
        await fresh.drop();
      }
    });
  },
);
