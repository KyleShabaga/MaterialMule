import { describe, expect, it } from 'vitest';
import { migrate, readMigrations } from '../db/migrator.js';
import { createTestSchema, testDatabaseUrl } from '../test-support/database.js';
import { insertProject, insertUser } from '../test-support/fixtures.js';

// MM-T27 migration 0055 on a database that already has MM-T25/T26 action items (open and
// resolved): the project backfill must run past the 0050 guard, and the guard must be back on.
describe.runIf(testDatabaseUrl)('migration 0055 upgrade (MM-T27)', () => {
  it('backfills project_id on existing open and resolved items and keeps the guard', async () => {
    const db = await createTestSchema();
    try {
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0055'),
      );
      const user = await insertUser(db.pool);
      const project = await insertProject(db.pool, 'DEMO-2601', user);
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO lab_program (project_id, program_number, status, created_by_account_user_id,
                                  created_by_account_type, requested_by_user_id,
                                  requested_by_name_snapshot, create_idempotency_key,
                                  submitted_at, submitted_by_account_user_id,
                                  submitted_by_account_type, submitted_by_name_snapshot,
                                  submitted_for_user_id, submitted_for_name_snapshot,
                                  submit_idempotency_key)
         VALUES ($1, 'LP-2026-0001', 'submitted', $2, 'personal', $2, 'Alex Tester',
                 gen_random_uuid(), now(), $2, 'personal', 'Alex Tester', $2, 'Alex Tester',
                 gen_random_uuid())
         RETURNING id`,
        [project, user],
      );
      const program = rows[0]!.id;
      for (const status of ['open', 'resolved']) {
        await db.pool.query(
          `INSERT INTO action_item (kind, target_user_id, entity_type, entity_id, program_id,
                                    created_by_user_id, created_by_name_snapshot, reason,
                                    idempotency_key, request_hash, status, resolved_at,
                                    resolved_by_user_id, resolution)
           VALUES ('closure_request', $2, 'lab_program', $1, $1, $2, 'Alex Tester', 'Done',
                   gen_random_uuid(), 'h', $3,
                   CASE WHEN $3 = 'resolved' THEN now() END,
                   CASE WHEN $3 = 'resolved' THEN $2::uuid END,
                   CASE WHEN $3 = 'resolved' THEN 'closed' END)`,
          [program, user, status],
        );
      }
      await migrate(db.pool, all);
      const { rows: items } = await db.pool.query<{ project_id: string }>(
        'SELECT project_id FROM action_item',
      );
      expect(items.map((i) => i.project_id)).toEqual([project, project]);
      await expect(db.pool.query('DELETE FROM action_item')).rejects.toMatchObject({
        code: '23001',
      });
    } finally {
      await db.drop();
    }
  }, 60_000);
});
