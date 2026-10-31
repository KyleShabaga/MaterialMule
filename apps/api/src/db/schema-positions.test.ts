import { afterEach, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// MISC-06 (migration 0012): staff positions are technician, technologist, engineer and
// lab_manager, or NULL. Project Engineer becomes Engineer on upgrade; nothing else about the
// person changes. Fictional people only.
describe.runIf(testDatabaseUrl)(
  'staff positions (MISC-06, migration 0012)',
  { timeout: 30_000 },
  () => {
    let db: TestSchema | undefined;

    afterEach(async () => {
      await db?.drop();
      db = undefined;
    });

    async function addPerson(pool: TestSchema['pool'], name: string, position: string | null) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, position, position_set_at,
                             account_type, status, job_title, job_title_override,
                             job_title_override_set_at, job_title_override_set_by_user_id)
       VALUES ($1, 'PX', $2, CASE WHEN $2::text IS NULL THEN NULL
                                  ELSE timestamptz '2026-10-01 12:00Z' END,
               'personal', 'active', 'Project Engineer', NULL, NULL, NULL)
       RETURNING id`,
        [name, position],
      );
      return rows[0]!.id;
    }

    const setPosition = (pool: TestSchema['pool'], id: string, position: string | null) =>
      pool.query('UPDATE app_user SET position = $2 WHERE id = $1', [id, position]);

    it('a fresh install allows exactly the four positions and Not set', async () => {
      db = await createTestSchema();
      await migrate(db.pool);
      const person = await addPerson(db.pool, 'Fresh Example', null);
      for (const position of ['technician', 'technologist', 'engineer', 'lab_manager', null]) {
        await setPosition(db.pool, person, position);
      }
      for (const retired of ['project_engineer', 'pm_pe', 'admin', '']) {
        await expect(setPosition(db.pool, person, retired)).rejects.toMatchObject({
          code: PG.checkViolation,
        });
      }
      // Nobody to convert: a fresh install records no migration event.
      const { rows } = await db.pool.query(
        `SELECT 1 FROM audit_event WHERE action LIKE '%position%consolidated'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('an upgrade turns Project Engineer into Engineer and changes nothing else', async () => {
      db = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0012'),
      );
      const pe = await addPerson(db.pool, 'Pat Upgrade', 'project_engineer');
      const tech = await addPerson(db.pool, 'Tia Upgrade', 'technician');
      const unset = await addPerson(db.pool, 'Nia Upgrade', null);
      await db.pool.query(
        `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
        [pe],
      );
      await db.pool.query(
        `INSERT INTO identity_link (user_id, provider, subject) VALUES ($1, 'test', 'pat-upgrade')`,
        [pe],
      );
      // An earlier audit value naming the retired position.
      await db.pool.query(
        `INSERT INTO audit_event (action, entity_type, entity_id, actor_account_type, before_values,
                                after_values)
       VALUES ('staff.profile_changed', 'app_user', $1, 'system', '{"position": null}',
               '{"position": "project_engineer"}')`,
        [pe],
      );
      const snapshot = async () =>
        (
          await db!.pool.query(
            `SELECT u.*, (SELECT array_agg(role) FROM role_assignment r WHERE r.user_id = u.id) AS roles,
                  (SELECT array_agg(subject) FROM identity_link i WHERE i.user_id = u.id) AS links
           FROM app_user u WHERE id = ANY($1) ORDER BY display_name`,
            [[pe, tech, unset]],
          )
        ).rows;
      const before = await snapshot();

      const result = await migrate(db.pool, all);
      expect(result.applied).toContain('0012_staff_positions');

      const after = await snapshot();
      expect(after.map((row) => row.position)).toEqual([null, 'engineer', 'technician']);
      // Only the position changed: IDs, initials, position time, titles, roles, identities.
      expect(after).toEqual(
        before.map((row) => (row.id === pe ? { ...row, position: 'engineer' } : row)),
      );

      const { rows: events } = await db.pool.query(
        `SELECT action, entity_id, actor_account_type, actor_name_snapshot, before_values,
              after_values
       FROM audit_event WHERE action IN ('user.position_consolidated',
                                         'migration.positions_consolidated', 'staff.profile_changed')
       ORDER BY action`,
      );
      expect(events).toEqual([
        {
          action: 'migration.positions_consolidated',
          entity_id: null,
          actor_account_type: 'system',
          actor_name_snapshot: 'Migration 0012',
          before_values: null,
          after_values: {
            migration: '0012_staff_positions',
            mapping: { project_engineer: 'engineer' },
            affected: 1,
          },
        },
        // The historical value stays readable as written.
        {
          action: 'staff.profile_changed',
          entity_id: pe,
          actor_account_type: 'system',
          actor_name_snapshot: null,
          before_values: { position: null },
          after_values: { position: 'project_engineer' },
        },
        {
          action: 'user.position_consolidated',
          entity_id: pe,
          actor_account_type: 'system',
          actor_name_snapshot: 'Migration 0012',
          before_values: { position: 'project_engineer' },
          after_values: { position: 'engineer' },
        },
      ]);
      await expect(setPosition(db.pool, tech, 'project_engineer')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
    });
  },
);
