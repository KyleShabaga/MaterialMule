import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject } from '../test-support/fixtures.js';

// MM-T91 (migration 0013): in-app notifications, proven in the database. Only active personal or
// test accounts receive them; only the read state changes; nothing is deleted; one row per
// (recipient, event); and the decision notice is written once, to the requester, when someone
// else resolves their request. Fictional data only (DEMO-2601, invented people).
describe.runIf(testDatabaseUrl)('notifications (MM-T91, migration 0013)', () => {
  let db: TestSchema;
  let lead: string;
  let manager: string;
  let requester: string;
  let fixture: string;
  let disabled: string;
  let lab: string;
  let projectId: string;

  async function person(name: string, accountType: string, status = 'active') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        name,
        accountType === 'shared_lab' ? null : name.slice(0, 2).toUpperCase(),
        accountType,
        status,
      ],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await person('Pat Example', 'personal');
    manager = await person('Lee Manager', 'personal');
    requester = await person('Alex Tester', 'personal');
    fixture = await person('Test Fixture', 'test');
    disabled = await person('Former Staff', 'personal', 'disabled');
    lab = await person('LAB', 'shared_lab');
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`, [
      manager,
    ]);
    projectId = await insertProject(db.pool, 'DEMO-2601', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** An open action item of a kind that needs no program, raised by `by`. */
  async function item(
    kind: 'retention_request' | 'team_join_request' | 'lead_appointment' | 'grant_review',
    by: string,
  ): Promise<string> {
    const shape = {
      retention_request: [`'lab_manager'`, `'retention_request'`, 'gen_random_uuid()'],
      team_join_request: ['NULL', `'team_join_request'`, 'gen_random_uuid()'],
      lead_appointment: [`'admin'`, `'project'`, '$1'],
      grant_review: ['NULL', `'project'`, '$1'],
    }[kind];
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_role, entity_type, entity_id, target_user_id,
                                project_id, created_by_user_id, created_by_name_snapshot, reason,
                                idempotency_key, request_hash)
       VALUES ($4, ${shape[0]}, ${shape[1]}, ${shape[2]}, $3::uuid, $1, $2, 'Someone',
               'Fictional reason', gen_random_uuid(), 'hash')
       RETURNING id`,
      [projectId, by, kind === 'lead_appointment' ? null : lead, kind],
    );
    return rows[0]!.id;
  }

  const resolve = (id: string, by: string, resolution: string) =>
    db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolution = $3, resolved_at = now(),
              resolved_by_user_id = $2
       WHERE id = $1 AND status = 'open'`,
      [id, by, resolution],
    );

  async function notify(recipient: string, itemId: string, what: 'opened' | 'decided' = 'opened') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [recipient, `action_request.${what}`, itemId, `action_item:${itemId}:${what}`],
    );
    return rows[0]!.id;
  }

  const decided = async (itemId: string) =>
    (
      await db.pool.query<{ recipient_user_id: string; read_at: Date | null }>(
        `SELECT recipient_user_id, read_at FROM notification
         WHERE action_item_id = $1 AND kind = 'action_request.decided'`,
        [itemId],
      )
    ).rows;

  it('only active personal or test accounts receive notifications (never LAB or disabled)', async () => {
    const id = await item('retention_request', requester);
    await notify(manager, id);
    await notify(fixture, id);
    for (const who of [lab, disabled]) {
      await expect(notify(who, id)).rejects.toMatchObject({
        code: PG.checkViolation,
        constraint: 'notification_recipient_check',
      });
    }
  });

  it('one row per recipient and event; the key and kind must match the linked item', async () => {
    const id = await item('retention_request', requester);
    await notify(lead, id);
    await expect(notify(lead, id)).rejects.toMatchObject({
      code: PG.uniqueViolation,
      constraint: 'notification_one_per_event',
    });
    // Another person's row for the same item is fine.
    await notify(manager, id);
    const insert = (kind: string, itemId: string | null, key: string) =>
      db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
         VALUES ($1, $2, $3, $4)`,
        [requester, kind, itemId, key],
      );
    await expect(insert('action_request.opened', null, 'x')).rejects.toMatchObject({
      constraint: 'notification_shape_check',
    });
    await expect(
      insert('action_request.opened', id, `action_item:${id}:decided`),
    ).rejects.toMatchObject({ constraint: 'notification_shape_check' });
    await expect(insert('project.updated', id, `action_item:${id}:opened`)).rejects.toMatchObject({
      constraint: 'notification_kind_check',
    });
  });

  it('only the read state changes: read once, dismiss and restore; nothing is deleted', async () => {
    const id = await item('retention_request', requester);
    const n = await notify(manager, id);
    const update = (set: string) =>
      db.pool.query(`UPDATE notification SET ${set} WHERE id = $1`, [n]);
    const refused = { code: PG.restrictViolation };

    // Dismissed means read.
    await expect(update('dismissed_at = now()')).rejects.toMatchObject({
      constraint: 'notification_dismissed_is_read',
    });
    await update('read_at = now()');
    await expect(update('read_at = NULL')).rejects.toMatchObject(refused);
    await expect(update(`read_at = read_at + interval '1 minute'`)).rejects.toMatchObject(refused);
    await update('dismissed_at = now()');
    await expect(update(`dismissed_at = dismissed_at + interval '1 minute'`)).rejects.toMatchObject(
      refused,
    );
    await update('dismissed_at = NULL');
    await update('dismissed_at = now()');
    await update('dismissed_at = NULL');

    for (const set of [
      `recipient_user_id = '${lead}'`,
      `kind = 'action_request.decided', event_key = 'action_item:${id}:decided'`,
      `action_item_id = '${await item('retention_request', requester)}'`,
      `created_at = now() - interval '1 day'`,
      `id = '${randomUUID()}'`,
    ]) {
      await expect(update(set), set).rejects.toMatchObject(refused);
    }
    await expect(
      db.pool.query('DELETE FROM notification WHERE id = $1', [n]),
    ).rejects.toMatchObject(refused);
    await expect(db.pool.query('TRUNCATE notification')).rejects.toMatchObject(refused);
    const { rows } = await db.pool.query(
      'SELECT read_at IS NOT NULL AS read, dismissed_at FROM notification WHERE id = $1',
      [n],
    );
    expect(rows).toEqual([{ read: true, dismissed_at: null }]);
  });

  it('reading and dismissing never touch the action item or the audit log', async () => {
    const id = await item('retention_request', requester);
    const n = await notify(lead, id);
    const snapshot = async () => ({
      item: (await db.pool.query('SELECT * FROM action_item WHERE id = $1', [id])).rows,
      audit: (await db.pool.query('SELECT count(*)::int AS n FROM audit_event')).rows,
    });
    const before = await snapshot();
    await db.pool.query(
      'UPDATE notification SET read_at = now(), dismissed_at = now() WHERE id = $1',
      [n],
    );
    await db.pool.query('UPDATE notification SET dismissed_at = NULL WHERE id = $1', [n]);
    expect(await snapshot()).toEqual(before);
  });

  it('decision notice: once, unread, to the requester when someone else resolves their request', async () => {
    const retention = await item('retention_request', requester);
    await resolve(retention, manager, 'declined');
    expect(await decided(retention)).toEqual([{ recipient_user_id: requester, read_at: null }]);

    const join = await item('team_join_request', fixture);
    await resolve(join, lead, 'accepted');
    expect((await decided(join)).map((row) => row.recipient_user_id)).toEqual([fixture]);
  });

  it('decision notice: none for a self-resolution, lead appointments, grant reviews, or a disabled, LAB or missing requester', async () => {
    const own = await item('retention_request', manager);
    await resolve(own, manager, 'approved');
    expect(await decided(own)).toEqual([]);

    const appointment = await item('lead_appointment', requester);
    await resolve(appointment, manager, 'appointed');
    expect(await decided(appointment)).toEqual([]);

    const review = await item('grant_review', requester);
    await resolve(review, lead, 'reviewed');
    expect(await decided(review)).toEqual([]);

    // The requester was disabled before the decision.
    const later = await person('Leaving Soon', 'personal');
    const gone = await item('retention_request', later);
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [later]);
    await resolve(gone, manager, 'declined');
    expect(await decided(gone)).toEqual([]);

    // Never written for the LAB account, even if a row names it as the requester.
    const station = await item('retention_request', lab);
    await resolve(station, manager, 'declined');
    expect(await decided(station)).toEqual([]);
  });

  it('decision notice: only on the open → resolved change, and a second writer adds nothing', async () => {
    const id = await item('retention_request', requester);
    // A reassignment while open is not a decision.
    await db.pool.query(
      'UPDATE action_item SET assigned_user_id = $2, assigned_at = now() WHERE id = $1',
      [id, manager],
    );
    expect(await decided(id)).toEqual([]);
    const first = await resolve(id, manager, 'approved');
    const second = await resolve(id, lead, 'declined');
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
    expect(await decided(id)).toHaveLength(1);
    // A decided row written earlier by any other path is kept, not duplicated.
    const again = await item('retention_request', requester);
    await notify(requester, again, 'decided');
    await resolve(again, manager, 'declined');
    expect(await decided(again)).toHaveLength(1);
  });

  it('opened rows outlive routing: resolving the item keeps them and their read state', async () => {
    const id = await item('retention_request', requester);
    const n = await notify(lead, id);
    await resolve(id, manager, 'approved');
    const { rows } = await db.pool.query(
      `SELECT recipient_user_id, kind, read_at FROM notification WHERE id = $1`,
      [n],
    );
    expect(rows).toEqual([
      { recipient_user_id: lead, kind: 'action_request.opened', read_at: null },
    ]);
  });
});
