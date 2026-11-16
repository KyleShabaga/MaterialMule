import {
  inboxBulkResultSchema,
  inboxSummarySchema,
  type InboxBulkResult,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-48: `POST /api/inbox/bulk` over checked rows, against real PostgreSQL. Fictional people
// and projects only (DEMO-2601 / DEMO-2602, Pat Example leads both).
//
// Fixture:
//   joinA, joinB   team join requests raised by Jordan Smith (js), routed to Pat (pe)
//   decided1/2     retention requests raised by Alex Tester (tech), approved by Pat: Alex gets
//                  two "decided" updates (the database trigger writes them)
//   jsDecided      one raised by Jordan, approved by Pat: Jordan's update
//   leadOnly       a lead appointment raised by Jordan, routed to admins: never Alex's
describe.runIf(testDatabaseUrl)('Inbox bulk actions (STRATA-48)', () => {
  let h: LabHarness;
  type As = Parameters<LabHarness['send']>[3];
  const ids = { joinA: '', joinB: '', decided1: '', decided2: '', jsDecided: '', leadOnly: '' };
  const updates = { tech1: '', tech2: '', js: '' };
  let pendingCookie: string;

  async function request(
    kind: 'retention_request' | 'team_join_request' | 'lead_appointment',
    project: string,
    by: string,
    byName: string,
  ): Promise<string> {
    const shape = {
      retention_request: [`'lab_manager'`, `'retention_request'`, 'gen_random_uuid()'],
      team_join_request: ['NULL', `'team_join_request'`, 'gen_random_uuid()'],
      lead_appointment: [`'admin'`, `'project'`, '$1'],
    }[kind];
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_role, entity_type, entity_id, target_user_id,
                                project_id, created_by_user_id, created_by_name_snapshot, reason,
                                idempotency_key, request_hash)
       VALUES ($4, ${shape[0]}, ${shape[1]}, ${shape[2]}, $3::uuid, $1, $2, $5,
               'Fictional reason', gen_random_uuid(), 'hash')
       RETURNING id`,
      [project, by, kind === 'lead_appointment' ? null : h.users.pe, kind, byName],
    );
    return rows[0]!.id;
  }

  async function resolve(id: string) {
    await h.db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolution = 'approved', resolved_at = now(),
              resolved_by_user_id = $2 WHERE id = $1`,
      [id, h.users.pe],
    );
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM notification WHERE action_item_id = $1 AND kind = 'action_request.decided'`,
      [id],
    );
    return rows[0]!.id;
  }

  async function bulk(body: unknown, as: As) {
    return h.send('post', '/api/inbox/bulk', body, as);
  }

  async function ok(body: unknown, as: As): Promise<InboxBulkResult> {
    const response = await bulk(body, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return inboxBulkResultSchema.parse(response.body);
  }

  /** Every request's workflow state and every read state: what a refused call must not change. */
  async function snapshot(): Promise<string> {
    const { rows } = await h.db.pool.query<{ state: string }>(
      `SELECT concat_ws('|',
         (SELECT string_agg(id || ':' || status || ':' || coalesce(resolution, '-') || ':'
                            || coalesce(assigned_user_id::text, '-'), ',' ORDER BY id)
          FROM action_item),
         (SELECT string_agg(user_id || ':' || action_item_id || ':' || coalesce(read_at::text, '-'),
                            ',' ORDER BY user_id, action_item_id)
          FROM inbox_request_read),
         (SELECT string_agg(id || ':' || coalesce(read_at::text, '-') || ':'
                            || coalesce(dismissed_at::text, '-'), ',' ORDER BY id)
          FROM notification)) AS state`,
    );
    return rows[0]!.state;
  }

  const notification = async (id: string) =>
    (
      await h.db.pool.query<{ read: boolean; dismissed: boolean }>(
        `SELECT read_at IS NOT NULL AS read, dismissed_at IS NOT NULL AS dismissed
         FROM notification WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  const summary = async (as: As) => {
    const response = await h.get('/api/inbox/summary', as);
    expect(response.status).toBe(200);
    return inboxSummarySchema.parse(response.body);
  };

  beforeAll(async () => {
    h = await createLabHarness();
    ids.joinA = await request('team_join_request', h.projects.a, h.users.js, 'Jordan Smith');
    ids.joinB = await request('team_join_request', h.projects.b, h.users.js, 'Jordan Smith');
    ids.decided1 = await request('retention_request', h.projects.a, h.users.tech, 'Alex Tester');
    ids.decided2 = await request('retention_request', h.projects.b, h.users.tech, 'Alex Tester');
    ids.jsDecided = await request('retention_request', h.projects.a, h.users.js, 'Jordan Smith');
    ids.leadOnly = await request('lead_appointment', h.projects.b, h.users.js, 'Jordan Smith');
    updates.tech1 = await resolve(ids.decided1);
    updates.tech2 = await resolve(ids.decided2);
    updates.js = await resolve(ids.jsDecided);

    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Pending Person', 'PP', 'personal', 'pending') RETURNING id`,
    );
    const session = await h.app.get(SessionService).create(rows[0]!.id, 'personal');
    pendingCookie = `${SESSION_COOKIE}=${session.token}`;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('LAB and pending accounts get 403, and nothing changes', async () => {
    const before = await snapshot();
    const body = { action: 'read', keys: [`request:${ids.joinA}`, `update:${updates.tech1}`] };
    const lab = await bulk(body, 'lab');
    expect(lab.status).toBe(403);
    expect(lab.body).toMatchObject({ code: 'forbidden' });
    const pending = await bulk(body, pendingCookie);
    expect(pending.status).toBe(403);
    expect(pending.body).toMatchObject({ code: 'access_pending' });
    expect(await snapshot()).toBe(before);
  });

  it('refuses a malformed body (400) without changing anything', async () => {
    const before = await snapshot();
    expect((await bulk({ action: 'decide', keys: [`request:${ids.joinA}`] }, 'pe')).status).toBe(
      400,
    );
    expect((await bulk({ action: 'read', keys: [] }, 'pe')).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => `request:${ids.joinA}`);
    expect((await bulk({ action: 'read', keys: tooMany }, 'pe')).status).toBe(400);
    expect(await snapshot()).toBe(before);
  });

  it('reads and unreads requests (read state only) and fails keys that are not mine', async () => {
    const before = await summary('pe');
    expect(before.counts.unreadRequests).toBe(2);
    const read = await ok(
      {
        action: 'read',
        keys: [
          `request:${ids.joinA}`,
          `request:${ids.joinB}`,
          // Routed to admins only, and someone else's update: never Pat's.
          `request:${ids.leadOnly}`,
          `update:${updates.js}`,
          'request:not-a-uuid',
          `update:00000000-0000-4000-8000-00000000dead`,
        ],
      },
      'pe',
    );
    expect(read.updated).toBe(2);
    expect(read.failed.sort()).toEqual(
      [
        `request:${ids.leadOnly}`,
        `update:${updates.js}`,
        'request:not-a-uuid',
        `update:00000000-0000-4000-8000-00000000dead`,
      ].sort(),
    );
    expect(read.summary.counts.unreadRequests).toBe(0);
    expect(read.summary.counts.badge).toBe(before.counts.badge - 2);
    // Jordan's update is untouched and the requests are still open.
    expect(await notification(updates.js)).toEqual({ read: false, dismissed: false });
    const { rows } = await h.db.pool.query<{ status: string }>(
      'SELECT status FROM action_item WHERE id = ANY($1::uuid[])',
      [[ids.joinA, ids.joinB, ids.leadOnly]],
    );
    expect(rows.every((row) => row.status === 'open')).toBe(true);

    const unread = await ok({ action: 'unread', keys: [`request:${ids.joinA}`] }, 'pe');
    expect(unread).toMatchObject({ updated: 1, failed: [] });
    expect(unread.summary.counts.unreadRequests).toBe(1);
  });

  it('reads and dismisses updates; a read update cannot be unread again', async () => {
    const read = await ok({ action: 'read', keys: [`update:${updates.tech1}`] }, 'tech');
    expect(read).toMatchObject({ updated: 1, failed: [] });
    expect(await notification(updates.tech1)).toEqual({ read: true, dismissed: false });

    // Unread: the still-unread update counts as done; the read one fails (read once, by design).
    const unread = await ok(
      { action: 'unread', keys: [`update:${updates.tech1}`, `update:${updates.tech2}`] },
      'tech',
    );
    expect(unread).toMatchObject({ updated: 1, failed: [`update:${updates.tech1}`] });
    expect(await notification(updates.tech1)).toEqual({ read: true, dismissed: false });

    const dismissed = await ok(
      { action: 'dismiss', keys: [`update:${updates.tech2}`, `update:${updates.js}`] },
      'tech',
    );
    expect(dismissed).toMatchObject({ updated: 1, failed: [`update:${updates.js}`] });
    expect(await notification(updates.tech2)).toEqual({ read: true, dismissed: true });
    expect(await notification(updates.js)).toEqual({ read: false, dismissed: false });
    expect(dismissed.summary.counts.unreadUpdates).toBe(0);
  });

  it('refuses dismiss with any request key (400 dismiss_requests) and changes nothing', async () => {
    const before = await snapshot();
    const response = await bulk(
      { action: 'dismiss', keys: [`update:${updates.js}`, `request:${ids.joinB}`] },
      'js',
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'dismiss_requests' });
    expect(await snapshot()).toBe(before);
    expect(await notification(updates.js)).toEqual({ read: false, dismissed: false });
  });
});
