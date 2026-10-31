import { afterEach, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// MISC-08 (migration 0013): existing reviewer assignments count as the lead's approval (owner
// decision 2026-10-31), recorded as a migration; the effective-eligibility rule lives in the
// database. Fictional people and projects only (DEMO-26xx).
describe.runIf(testDatabaseUrl)(
  'review eligibility (MISC-08, migration 0013)',
  { timeout: 30_000 },
  () => {
    let db: TestSchema | undefined;

    afterEach(async () => {
      await db?.drop();
      db = undefined;
    });

    async function eligibility(pool: TestSchema['pool'], userId: string, by: string) {
      await pool.query(
        `INSERT INTO reviewer_eligibility (user_id, user_name_snapshot, scope_code, granted_by_user_id,
         granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
       VALUES ($1, 'Reviewer', 'concrete_field', $2, 'Admin', 'Certified', gen_random_uuid(), 'h')`,
        [userId, by],
      );
    }
    async function assignment(
      pool: TestSchema['pool'],
      projectId: string,
      userId: string,
      by: string,
    ) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO project_reviewer_assignment (project_id, reviewer_user_id, reviewer_name_snapshot,
         scope_code, assigned_by_user_id, assigned_by_name_snapshot, assign_reason,
         assign_idempotency_key, assign_request_hash)
       VALUES ($1, $2, 'Reviewer', 'concrete_field', $3, 'Admin', 'Reviews', gen_random_uuid(), 'h')
       RETURNING id`,
        [projectId, userId, by],
      );
      return rows[0]!.id;
    }

    it('an upgrade records each workable assignment as approved by the lead, audited as a migration', async () => {
      db = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0013'),
      );
      const lead = await insertUser(db.pool, 'PE');
      const admin = await insertUser(db.pool, 'ADM');
      const eligible = await insertUser(db.pool, 'EL');
      const lapsed = await insertUser(db.pool, 'LA');
      const project = await insertProject(db.pool, 'DEMO-2691', lead);
      const leaderless = await insertProject(db.pool, 'DEMO-2692', lead);
      await db.pool.query('UPDATE project SET lead_project_engineer_user_id = NULL WHERE id = $1', [
        leaderless,
      ]);
      await eligibility(db.pool, eligible, admin);
      const approvedAssignment = await assignment(db.pool, project, eligible, admin);
      await assignment(db.pool, project, lapsed, admin);
      await assignment(db.pool, leaderless, eligible, admin);

      expect((await migrate(db.pool, all)).applied).toContain('0013_review_eligibility');

      const { rows } = await db.pool.query(
        `SELECT reviewer_assignment_id, reviewer_user_id, approved_by_user_id, ended_at
       FROM project_review_approval`,
      );
      expect(rows).toEqual([
        {
          reviewer_assignment_id: approvedAssignment,
          reviewer_user_id: eligible,
          approved_by_user_id: lead,
          ended_at: null,
        },
      ]);
      const { rows: audit } = await db.pool.query(
        `SELECT actor_account_type, actor_name_snapshot, after_values ->> 'migration' AS migration
       FROM audit_event WHERE action = 'project_review_approval.approved'`,
      );
      expect(audit).toEqual([
        { actor_account_type: 'system', actor_name_snapshot: 'Migration 0013', migration: '0013' },
      ]);
    });

    it('a fresh install backfills nothing, and the database enforces the rules', async () => {
      db = await createTestSchema();
      await migrate(db.pool);
      expect((await db.pool.query('SELECT 1 FROM project_review_approval')).rows).toHaveLength(0);
      const admin = await insertUser(db.pool, 'ADM');
      const person = await insertUser(db.pool, 'RV');
      // No position is eligible by default.
      await db.pool.query(`UPDATE app_user SET position = 'engineer' WHERE id = $1`, [person]);
      const eligible = async () =>
        (
          await db!.pool.query<{ ok: boolean }>(
            `SELECT reviewer_is_eligible($1, 'concrete_field') AS ok`,
            [person],
          )
        ).rows[0]!.ok;
      expect(await eligible()).toBe(false);
      const rule = (position: string) =>
        db!.pool.query(
          `INSERT INTO review_position_rule (position, scope_code, granted_by_user_id,
           granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
         VALUES ($1, 'concrete_field', $2, 'Admin', 'Engineers review', gen_random_uuid(), 'h')`,
          [position, admin],
        );
      await rule('engineer');
      expect(await eligible()).toBe(true);
      await expect(rule('engineer')).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(rule('project_engineer')).rejects.toMatchObject({ code: PG.checkViolation });
      const exclusion = (scope: string | null) =>
        db!.pool.query(
          `INSERT INTO reviewer_exclusion (user_id, user_name_snapshot, scope_code,
           granted_by_user_id, granted_by_name_snapshot, grant_reason, grant_idempotency_key,
           grant_request_hash)
         VALUES ($1, 'Reviewer', $2, $3, 'Admin', 'Paused', gen_random_uuid(), 'h')`,
          [person, scope, admin],
        );
      await exclusion('concrete_strength');
      expect(await eligible()).toBe(true);
      await exclusion(null);
      expect(await eligible()).toBe(false);
      // One active all-scopes exclusion per person; history rows can't be deleted.
      await expect(exclusion(null)).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(db.pool.query('DELETE FROM reviewer_exclusion')).rejects.toMatchObject({
        code: '23001',
      });
    });
  },
);
