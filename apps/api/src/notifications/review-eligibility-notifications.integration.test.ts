import {
  actionRequestListSchema,
  notificationCountSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  projectReviewersSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T91 × MISC-08: when a reviewer actually loses review eligibility, the lead's
// review_approval_lost request is announced like every other action request: one Pending action,
// one in-app "opened" notification for the lead, and the opted-in email row, all once. Reading or
// dismissing the notification leaves the request open; the lead's fresh approval resolves it and
// the notification then shows the resolved state. Real PostgreSQL through the API; nothing is
// emailed (EMAIL_ENABLED is false, the outbox is asserted directly). Fictional data only:
// DEMO-2601 led by Pat Example (`pe`).
describe.runIf(testDatabaseUrl)('eligibility loss is announced in-app (MM-T91, MISC-08)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  const FIELD = 'concrete_field';

  const send = async (method: 'post' | 'delete' | 'put', path: string, body: unknown, as: string) =>
    h
      .http()
      [method](path)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as] ?? as)
      .send(body as object);
  const get = (path: string, as: string) =>
    h
      .http()
      .get(path)
      .set('Cookie', cookies[as] ?? as);
  const projectPath = (rest: string) => `/api/projects/${h.projects.a}/${rest}`;

  async function person(name: string) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, 'RL', 'personal', 'active') RETURNING id`,
      [name],
    );
    const id = rows[0]!.id;
    cookies[id] =
      `${SESSION_COOKIE}=${(await h.app.get(SessionService).create(id, 'personal')).token}`;
    return id;
  }

  async function lostItems(reviewerName: string) {
    const { rows } = await h.db.pool.query<{ id: string; status: string; resolution: string }>(
      `SELECT id, status, resolution FROM action_item
       WHERE kind = 'review_approval_lost' AND reason LIKE '%' || $1 || '%' ORDER BY created_at`,
      [reviewerName],
    );
    return rows;
  }
  const notificationRows = async (itemId: string) =>
    (
      await h.db.pool.query<{ row: string }>(
        `SELECT kind || ' ' || recipient_user_id AS row FROM notification
         WHERE action_item_id = $1 ORDER BY 1`,
        [itemId],
      )
    ).rows.map((r) => r.row);
  const outbox = async (itemId: string) =>
    (
      await h.db.pool.query<{ recipient_user_id: string }>(
        'SELECT recipient_user_id FROM email_outbox WHERE action_item_id = $1',
        [itemId],
      )
    ).rows.map((r) => r.recipient_user_id);
  const pendingFor = async (as: string) => {
    const response = await get('/api/action-items?status=open&scope=mine', as);
    expect(response.status).toBe(200);
    return actionRequestListSchema.parse(response.body).items;
  };
  const pendingCount = async (as: string) =>
    (await get('/api/action-items/count', as)).body.open as number;
  const unread = async (as: string) =>
    notificationCountSchema.parse((await get('/api/notifications/count', as)).body).unread;
  const notices = async (as: string, itemId: string) =>
    notificationListSchema
      .parse((await get('/api/notifications?filter=all&limit=100', as)).body)
      .items.filter((n) => n.linkedRequest?.id === itemId);

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['admin', 'pe', 'js', 'lm'] as const) cookies[key] = await h.cookie(key);
    // Pat opts in to email, so the announce path's email half is checked too.
    await h.db.pool.query(
      `UPDATE app_user SET work_email = 'pat.example@example.test' WHERE id = $1`,
      [h.users.pe],
    );
    const prefs = notificationPreferencesSchema.parse(
      (await get('/api/me/notification-preferences', 'pe')).body,
    );
    const saved = await send(
      'put',
      '/api/me/notification-preferences',
      { emailActionRequests: true, version: prefs.version },
      'pe',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('actual eligibility loss: one Pending action, one in-app notice, read/dismiss resolve nothing, the fresh approval does', async () => {
    // An eligible, accepted, assigned and approved reviewer on DEMO-2601 (FIELD).
    const reviewer = await person('Rhea Lostreview');
    const granted = await send(
      'post',
      `/api/staff/${reviewer}/reviewer-eligibility`,
      { scopeCode: FIELD, reason: 'Certified', idempotencyKey: newKey() },
      'admin',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const joined = await send(
      'post',
      projectPath('team-members'),
      { userId: reviewer, reason: 'On the project', idempotencyKey: newKey() },
      'admin',
    );
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    const assigned = await send(
      'post',
      projectPath('reviewer-assignments'),
      {
        reviewerUserId: reviewer,
        scopeCode: FIELD,
        reason: 'Reviews this',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    const assignment = projectReviewersSchema
      .parse(assigned.body)
      .active.find((r) => r.reviewer.userId === reviewer)!.id;
    const approve = () =>
      send(
        'post',
        projectPath(`reviewer-assignments/${assignment}/approval`),
        { idempotencyKey: newKey() },
        'pe',
      );
    expect((await approve()).status).toBe(201);
    expect(await lostItems('Rhea Lostreview')).toEqual([]);

    const pendingBefore = await pendingCount('pe');
    const unreadBefore = await unread('pe');
    const others = { js: await unread('js'), lm: await unread('lm'), admin: await unread('admin') };

    // Actual loss: an all-scope exclusion ends the approval in the same transaction.
    const excluded = await send(
      'post',
      `/api/staff/${reviewer}/reviewer-exclusions`,
      { scopeCode: null, reason: 'Under review', idempotencyKey: newKey() },
      'admin',
    );
    expect(excluded.status, JSON.stringify(excluded.body)).toBe(201);
    const [item, ...extra] = await lostItems('Rhea Lostreview');
    expect(extra).toEqual([]);
    expect(item).toMatchObject({ status: 'open', resolution: null });

    // The Pending action, with its own title and link.
    expect(await pendingCount('pe')).toBe(pendingBefore + 1);
    const request = (await pendingFor('pe')).find((r) => r.id === item!.id)!;
    expect(request).toMatchObject({ kind: 'review_approval_lost', status: 'open' });
    // Exactly one in-app notice, for the lead only, and the opted-in email row once.
    expect(await notificationRows(item!.id)).toEqual([`action_request.opened ${h.users.pe}`]);
    expect(await outbox(item!.id)).toEqual([h.users.pe]);
    expect(await unread('pe')).toBe(unreadBefore + 1);
    expect({
      js: await unread('js'),
      lm: await unread('lm'),
      admin: await unread('admin'),
    }).toEqual(others);
    const [notice, ...more] = await notices('pe', item!.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({
      kind: 'action_request.opened',
      title: request.title,
      href: request.href,
      projectId: h.projects.a,
      readAt: null,
      linkedRequest: { kind: 'review_approval_lost', status: 'open', stillYours: true },
    });

    // A second exclusion finds nothing more to end: no second request, notice or email.
    const again = await send(
      'post',
      `/api/staff/${reviewer}/reviewer-exclusions`,
      { scopeCode: FIELD, reason: 'Under review', idempotencyKey: newKey() },
      'admin',
    );
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await lostItems('Rhea Lostreview')).map((r) => r.id)).toEqual([item!.id]);
    expect(await notificationRows(item!.id)).toEqual([`action_request.opened ${h.users.pe}`]);
    expect(await outbox(item!.id)).toEqual([h.users.pe]);

    // Reading and dismissing the notice change only the notice.
    for (const action of ['read', 'dismiss']) {
      const response = await send('post', `/api/notifications/${notice!.id}/${action}`, {}, 'pe');
      expect(response.status, action).toBe(200);
      expect(await lostItems('Rhea Lostreview'), action).toEqual([
        { id: item!.id, status: 'open', resolution: null },
      ]);
      expect(await pendingCount('pe'), action).toBe(pendingBefore + 1);
    }
    expect(await unread('pe')).toBe(unreadBefore);

    // Eligibility returns; only the lead's fresh approval resolves the request.
    const grants = (await get(`/api/staff/${reviewer}/grants`, 'admin')).body as {
      exclusions: { active: { id: string }[] };
    };
    for (const x of grants.exclusions.active) {
      const removed = await send(
        'delete',
        `/api/staff/${reviewer}/reviewer-exclusions/${x.id}`,
        { reason: 'Review finished' },
        'admin',
      );
      expect(removed.status).toBe(200);
    }
    expect(await lostItems('Rhea Lostreview')).toEqual([
      { id: item!.id, status: 'open', resolution: null },
    ]);
    expect((await approve()).status).toBe(201);
    expect(await lostItems('Rhea Lostreview')).toEqual([
      { id: item!.id, status: 'resolved', resolution: 'reassigned' },
    ]);
    expect(await pendingCount('pe')).toBe(pendingBefore);
    expect((await pendingFor('pe')).map((r) => r.id)).not.toContain(item!.id);
    // The (dismissed) notice now reads resolved, and no decision notice is added for this kind.
    const [resolved, ...stillMore] = await notices('pe', item!.id);
    expect(stillMore).toEqual([]);
    expect(resolved).toMatchObject({
      id: notice!.id,
      linkedRequest: {
        status: 'resolved',
        resolution: 'reassigned',
        resolvedBy: { userId: h.users.pe },
        stillYours: false,
      },
    });
    expect(resolved!.dismissedAt).not.toBeNull();
    expect(await notificationRows(item!.id)).toEqual([`action_request.opened ${h.users.pe}`]);
    expect(await unread('pe')).toBe(unreadBefore);
  });
});
