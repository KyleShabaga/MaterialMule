import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C29 (migration 0023): concrete notifications on the MM-T91 table, each rule proven in the
// database. Fictional data only (DEMO- projects, invented people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

describe.runIf(testDatabaseUrl)('concrete notifications (MM-V2-C29, migration 0023)', () => {
  let db: TestSchema;
  let tech: string;
  let reviewer: string;
  let project: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    reviewer = await insertUser(db.pool, 'RV');
    project = await insertProject(db.pool, 'DEMO-2601', reviewer);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function report() {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (project_id, created_by_user_id, technician_user_id)
       VALUES ($1, $2, $2) RETURNING id`,
      [project, tech],
    );
    return rows[0]!.id;
  }

  /** A submitted v1 and one transition of `action` on it. */
  async function transition(reportId: string, action: 'return' | 'review' = 'return') {
    const { rows: version } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_report_version (project_id, field_report_id, version_no, snapshot,
         snapshot_sha256, report_row_version, submitted_by_user_id, submitted_staff_user_id,
         route_kind)
       VALUES ($1, $2, 1, '{"kind":"field"}', 'ignored', 1, $3, $3, 'designated_reviewers')
       RETURNING id`,
      [project, reportId, tech],
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_report_transition (project_id, field_report_id, version_id, action,
         from_state, to_state, actor_user_id, comment, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, 'submitted', $5, $6, $7, $8, 'hash') RETURNING id`,
      [
        project,
        reportId,
        version[0]!.id,
        action,
        action === 'return' ? 'returned' : 'reviewed',
        reviewer,
        action === 'return' ? 'Fictional correction' : null,
        randomUUID(),
      ],
    );
    return rows[0]!.id;
  }

  const insert = (values: Record<string, unknown>) => {
    const columns = Object.keys(values);
    return db.pool.query<{ id: string }>(
      `INSERT INTO notification (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
  };

  const returned = (reportId: string, transitionId: string, recipient = tech) =>
    insert({
      recipient_user_id: recipient,
      kind: 'concrete_report.returned',
      concrete_field_report_id: reportId,
      concrete_report_transition_id: transitionId,
      event_key: `concrete_report_transition:${transitionId}:returned`,
    });

  it('a returned notice names the report, its return event and the matching key', async () => {
    const reportId = await report();
    const t = await transition(reportId);
    await expect(returned(reportId, t)).resolves.toMatchObject({ rowCount: 1 });
    // One per (recipient, event): the MM-T91 key still holds.
    await expect(returned(reportId, t)).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'notification_one_per_event',
    });
    await expect(
      insert({
        recipient_user_id: reviewer,
        kind: 'concrete_report.returned',
        concrete_field_report_id: reportId,
        concrete_report_transition_id: t,
        event_key: `concrete_report_transition:${t}:other`,
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'notification_shape_check' });
    await expect(
      insert({
        recipient_user_id: reviewer,
        kind: 'concrete_report.returned',
        concrete_field_report_id: reportId,
        event_key: `concrete_report_transition:${t}:returned`,
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'notification_shape_check' });
  });

  it('a returned notice must name a return of that same report', async () => {
    const reportId = await report();
    const reviewed = await transition(reportId, 'review');
    await expect(returned(reportId, reviewed, reviewer)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'notification_concrete_return_check',
    });
    const other = await report();
    const otherReturn = await transition(other);
    await expect(returned(reportId, otherReturn, reviewer)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'notification_concrete_return_check',
    });
  });

  it('the other concrete kinds point at exactly one report or specimen, keyed by their kind', async () => {
    const reportId = await report();
    for (const kind of [
      'concrete_curing.out_of_range',
      'concrete_equipment.flagged',
      'concrete_test.failed',
      'concrete_report.auto_submitted',
    ]) {
      await expect(
        insert({
          recipient_user_id: reviewer,
          kind,
          concrete_field_report_id: reportId,
          event_key: `${kind}:${randomUUID()}`,
        }),
      ).resolves.toMatchObject({ rowCount: 1 });
      // No target, a key for another kind, or a bare prefix.
      for (const values of [
        { event_key: `${kind}:${randomUUID()}` },
        { concrete_field_report_id: reportId, event_key: `other:${randomUUID()}` },
        { concrete_field_report_id: reportId, event_key: `${kind}:` },
      ]) {
        await expect(
          insert({ recipient_user_id: reviewer, kind, ...values }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'notification_shape_check' });
      }
    }
    // A specimen must exist.
    await expect(
      insert({
        recipient_user_id: reviewer,
        kind: 'concrete_test.failed',
        concrete_specimen_id: randomUUID(),
        event_key: `concrete_test.failed:${randomUUID()}`,
      }),
    ).rejects.toMatchObject(FOREIGN);
  });

  it('action-request notices never carry a concrete target, and unknown kinds stay refused', async () => {
    const reportId = await report();
    const itemId = randomUUID();
    await expect(
      insert({
        recipient_user_id: tech,
        kind: 'action_request.opened',
        action_item_id: itemId,
        concrete_field_report_id: reportId,
        event_key: `action_item:${itemId}:opened`,
      }),
    ).rejects.toMatchObject(REJECT);
    await expect(
      insert({
        recipient_user_id: tech,
        kind: 'concrete_report.issued',
        concrete_field_report_id: reportId,
        event_key: `concrete_report.issued:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'notification_kind_check' });
  });

  it('only the read state changes: the concrete targets are frozen', async () => {
    const reportId = await report();
    const t = await transition(reportId);
    const { rows } = await returned(reportId, t);
    const id = rows[0]!.id;
    const other = await report();
    for (const set of [
      `concrete_field_report_id = '${other}'`,
      'concrete_report_transition_id = NULL',
      `concrete_specimen_id = '${randomUUID()}'`,
    ]) {
      await expect(
        db.pool.query(`UPDATE notification SET ${set} WHERE id = $1`, [id]),
      ).rejects.toMatchObject(RESTRICT);
    }
    await expect(
      db.pool.query(`UPDATE notification SET read_at = now(), dismissed_at = now() WHERE id = $1`, [
        id,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      db.pool.query('DELETE FROM notification WHERE id = $1', [id]),
    ).rejects.toMatchObject(RESTRICT);
  });

  it('LAB never receives a concrete notice', async () => {
    const { rows: lab } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
    );
    const reportId = await report();
    const t = await transition(reportId);
    await expect(returned(reportId, t, lab[0]!.id)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'notification_recipient_check',
    });
  });

  describe('populated database', () => {
    let fresh: TestSchema | undefined;
    afterAll(async () => {
      await fresh?.drop();
    });

    it('existing notifications keep their rows and gain empty concrete targets', async () => {
      fresh = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        fresh.pool,
        all.filter((m) => m.version < '0023'),
      );
      await runSeed(fresh.pool, 'reference', 'test');
      const user = await insertUser(fresh.pool, 'MG');
      const projectId = await insertProject(fresh.pool, 'DEMO-2699', user);
      const { rows: item } = await fresh.pool.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_role, entity_type, entity_id, project_id,
                                  created_by_user_id, created_by_name_snapshot, reason,
                                  idempotency_key, request_hash)
         VALUES ('retention_request', 'lab_manager', 'retention_request', gen_random_uuid(), $1,
                 $2, 'Someone', 'Fictional reason', gen_random_uuid(), 'hash')
         RETURNING id`,
        [projectId, user],
      );
      await fresh.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
         VALUES ($1, 'action_request.opened', $2::uuid, 'action_item:' || $2::text || ':opened')`,
        [user, item[0]!.id],
      );
      const before = await fresh.pool.query(
        'SELECT row_to_json(n)::jsonb AS row FROM notification n',
      );
      expect(
        (
          await migrate(
            fresh.pool,
            all.filter((m) => m.version <= '0023'),
          )
        ).applied,
      ).toEqual(['0023_concrete_notifications']);
      const after = await fresh.pool.query(
        'SELECT row_to_json(n)::jsonb AS row FROM notification n',
      );
      expect(after.rows).toEqual([
        {
          row: {
            ...before.rows[0].row,
            concrete_field_report_id: null,
            concrete_specimen_id: null,
            concrete_report_transition_id: null,
          },
        },
      ]);
    }, 60_000);
  });
});
