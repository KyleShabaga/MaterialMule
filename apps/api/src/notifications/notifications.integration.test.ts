import {
  labProgramReviewSchema,
  labProgramSchema,
  notificationCountSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  projectDetailSchema,
  type LabProgram,
  type Notification,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { announceActionItem } from './action-items.js';

// MM-T91: notifications are separate from action requests. Creating, reassigning or rerouting a
// request gives each person it now waits on one "opened" notification; someone else resolving a
// request gives its requester one "decided" notice. Reading, dismissing and restoring change only
// the notification. Real PostgreSQL; nothing is emailed (EMAIL_ENABLED is false, the outbox is
// asserted directly). Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), led by Pat Example
// (`pe`); Lee Manager (`lm`) Lab Manager; Alex Tester (`tech`); Jordan Smith (`js`) and Jamie
// Song (`jo`) with no role.
describe.runIf(testDatabaseUrl)('notifications (MM-T91)', () => {
  let h: LabHarness;
  let moisture: string;
  let lou: string;
  type As = Parameters<LabHarness['send']>[3];
  const cookies = new Map<string, string>();

  async function person(name: string, initials: string, roles: string[] = []) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, initials],
    );
    const id = rows[0]!.id;
    for (const role of roles) {
      await h.db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        id,
        role,
      ]);
    }
    const session = await h.app.get(SessionService).create(id, 'personal');
    cookies.set(id, `${SESSION_COOKIE}=${session.token}`);
    return id;
  }
  const as = (id: string) => cookies.get(id)!;

  async function submit(projectId: string, lines: unknown[]): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId, idempotencyKey: newKey(), lines },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
    );
    const submitted = await h.send(
      'post',
      `/api/lab-programs/${created.body.id}/submit`,
      {
        version: created.body.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return labProgramSchema.parse(submitted.body);
  }

  async function program(project: 'a' | 'b' = 'a') {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects[project], `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    await h.bucket({ project, hole: holeId });
    const p = await submit(h.projects[project], [
      line({ kind: 'test_hole', id: holeId }, 'all', [moisture]),
    ]);
    return { program: p, testId: p.lines[0]!.requests[0]!.id };
  }

  const version = async (table: 'test_request' | 'lab_program', id: string) =>
    (await h.db.pool.query<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [id]))
      .rows[0]!.version;

  async function closeRequest(programId: string, who: As = 'tech', key = newKey()) {
    const made = await h.send(
      'post',
      `/api/lab-programs/${programId}/close-request`,
      { reason: 'All tests are done', idempotencyKey: key },
      who,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.actionItemId as string;
  }
  async function cancelRequest(testId: string, who: As = 'tech') {
    const made = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel-request`,
      { reason: 'Client withdrew this test', idempotencyKey: newKey() },
      who,
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.actionItemId as string;
  }
  async function cancelTest(testId: string, who: As = 'pe') {
    const cancelled = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel`,
      {
        reason: 'Client withdrew',
        version: await version('test_request', testId),
        idempotencyKey: newKey(),
      },
      who,
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  }
  const reassign = (id: string, to: string, reason = 'Covering this week') =>
    h.send(
      'post',
      `/api/action-items/${id}/reassign`,
      { toUserId: to, reason, idempotencyKey: newKey() },
      'admin',
    );

  async function setLead(project: 'a' | 'b', lead: string | null, reason: string) {
    const detail = projectDetailSchema.parse(
      (await h.get(`/api/projects/${h.projects[project]}`, 'admin')).body,
    );
    const saved = await h.send(
      'patch',
      `/api/projects/${h.projects[project]}`,
      { version: detail.version, leadProjectEngineerId: lead, reason },
      'admin',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  async function list(who: As, filter?: string): Promise<Notification[]> {
    const response = await h.get(`/api/notifications${filter ? `?filter=${filter}` : ''}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return notificationListSchema.parse(response.body).items;
  }
  const about = async (who: As, itemId: string, filter?: string) =>
    (await list(who, filter)).filter((n) => n.linkedRequest?.id === itemId);
  async function unread(who: As) {
    const response = await h.get('/api/notifications/count', who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return notificationCountSchema.parse(response.body).unread;
  }
  const pending = async (who: As) => (await h.get('/api/action-items/count', who)).body.open;
  const mutate = (who: As, path: string) => h.send('post', `/api/notifications/${path}`, {}, who);

  /** Rows for `itemId` in the database, by recipient and kind. */
  const rows = async (itemId: string) =>
    (
      await h.db.pool.query<{ recipient_user_id: string; kind: string }>(
        `SELECT recipient_user_id, kind FROM notification WHERE action_item_id = $1
         ORDER BY kind, recipient_user_id`,
        [itemId],
      )
    ).rows.map((row) => `${row.kind} ${row.recipient_user_id}`);
  const opened = (...people: string[]) => people.map((id) => `action_request.opened ${id}`).sort();

  const count = async (sql: string, params: unknown[] = []) =>
    (await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;

  async function emailPreference(who: As, on: boolean) {
    const current = notificationPreferencesSchema.parse(
      (await h.get('/api/me/notification-preferences', who)).body,
    );
    const saved = await h
      .http()
      .put('/api/me/notification-preferences')
      .set('Cookie', who.startsWith(SESSION_COOKIE) ? who : await h.cookie(who as 'pe'))
      .set(CSRF_HEADER, '1')
      .send({ emailActionRequests: on, version: current.version });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC-T91', 'Moisture content (fictional)', 'Moisture')).id;
    // A second Lab Manager, so role-shared items have two Lab Manager recipients.
    lou = await person('Lou Second', 'LS', ['lab_manager']);
    await h.db.pool.query(
      `UPDATE app_user SET work_email = lower(replace(display_name, ' ', '.')) || '@example.test'
       WHERE id = ANY($1::uuid[])`,
      [[h.users.pe, h.users.lm, lou]],
    );
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1/AC5: a new request gives each person it is routed to one unread "opened" row, nobody else', async () => {
    const { program: p, testId } = await program();
    const peBefore = await unread('pe');
    const closure = await closeRequest(p.id);
    expect(await rows(closure)).toEqual(opened(h.users.pe));
    expect(await unread('pe')).toBe(peBefore + 1);
    const [row] = await about('pe', closure);
    expect(row).toMatchObject({
      kind: 'action_request.opened',
      title: `Closure requested for ${p.programNumber}`,
      projectId: h.projects.a,
      projectNumber: 'DEMO-2601',
      href: `/lab-testing/programs/${p.id}`,
      readAt: null,
      dismissedAt: null,
      linkedRequest: {
        id: closure,
        kind: 'closure_request',
        status: 'open',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        stillYours: true,
      },
    });
    // The requester and people it isn't routed to get nothing (a requester is not a recipient).
    for (const who of ['tech', 'lm', 'admin', 'js'] as const) {
      expect(await about(who, closure), who).toEqual([]);
    }

    // Role-shared: the Lead Project Engineer and every Lab Manager.
    const cancellation = await cancelRequest(testId);
    expect(await rows(cancellation)).toEqual(opened(h.users.pe, h.users.lm, lou));
    expect(await about(as(lou), cancellation)).toHaveLength(1);
  });

  it('AC1: a retried request and a second announce add no duplicate rows', async () => {
    const { program: p } = await program();
    const key = newKey();
    const [first, second] = await Promise.all([
      h.send(
        'post',
        `/api/lab-programs/${p.id}/close-request`,
        { reason: 'All tests are done', idempotencyKey: key },
        'tech',
      ),
      h.send(
        'post',
        `/api/lab-programs/${p.id}/close-request`,
        { reason: 'All tests are done', idempotencyKey: key },
        'tech',
      ),
    ]);
    const ids = new Set(
      [first, second].filter((r) => r.status === 201).map((r) => r.body.actionItemId as string),
    );
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(await closeRequest(p.id, 'tech', key)).toBe(id);
    const client = await h.db.pool.connect();
    try {
      await announceActionItem(client, id!);
      await announceActionItem(client, id!);
    } finally {
      client.release();
    }
    expect(await rows(id!)).toEqual(opened(h.users.pe));
  });

  it('AC3/AC7: read, dismiss, restore and read-all change only the notification', async () => {
    const { program: p } = await program();
    const closure = await closeRequest(p.id);
    const second = await closeRequest((await program()).program.id);
    const [row] = await about('pe', closure);
    const [secondRow] = await about('pe', second);
    const snapshot = async () => ({
      items: (
        await h.db.pool.query('SELECT * FROM action_item WHERE id = ANY($1) ORDER BY id', [
          [closure, second],
        ])
      ).rows,
      audit: await count('FROM audit_event'),
      outbox: await count('FROM email_outbox'),
      pending: await pending('pe'),
    });
    const before = await snapshot();
    const start = await unread('pe');

    const read = await mutate('pe', `${row!.id}/read`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(notificationCountSchema.parse(read.body)).toEqual({ unread: start - 1 });
    // Idempotent: reading it again is fine and changes nothing.
    const again = await mutate('pe', `${row!.id}/read`);
    expect(again.body).toEqual({ unread: start - 1 });
    const [readRow] = await about('pe', closure);
    expect(readRow!.readAt).not.toBeNull();
    expect(await about('pe', closure, 'unread')).toEqual([]);

    const dismissed = await mutate('pe', `${row!.id}/dismiss`);
    expect(dismissed.body).toEqual({ unread: start - 1 });
    expect((await mutate('pe', `${row!.id}/dismiss`)).status).toBe(200);
    expect(await about('pe', closure)).toEqual([]);
    const [hidden] = await about('pe', closure, 'all');
    expect(hidden).toMatchObject({ readAt: readRow!.readAt });
    expect(hidden!.dismissedAt).not.toBeNull();

    const restored = await mutate('pe', `${row!.id}/restore`);
    expect(restored.body).toEqual({ unread: start - 1 });
    expect((await mutate('pe', `${row!.id}/restore`)).status).toBe(200);
    expect(await about('pe', closure)).toMatchObject([
      { readAt: readRow!.readAt, dismissedAt: null },
    ]);

    // Dismissing an unread one marks it read too.
    const beforeDismiss = await unread('pe');
    expect((await mutate('pe', `${secondRow!.id}/dismiss`)).body).toEqual({
      unread: beforeDismiss - 1,
    });
    await mutate('pe', `${secondRow!.id}/restore`);
    expect(await unread('pe')).toBe(beforeDismiss - 1);

    const all = await mutate('pe', 'read-all');
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ unread: 0 });
    expect(await unread('pe')).toBe(0);
    expect((await mutate('pe', 'read-all')).body).toEqual({ unread: 0 });

    expect(await snapshot()).toEqual(before);
    expect((await h.get('/api/notifications?filter=everything', 'pe')).status).toBe(400);
  });

  it('AC4: resolving through the real workflow drops the pending count, not the unread count, and tells the requester once', async () => {
    const { program: p, testId } = await program();
    const closure = await closeRequest(p.id);
    await cancelTest(testId);
    const pendingBefore = await pending('pe');
    const unreadBefore = await unread('pe');
    const techBefore = await unread('tech');

    const close = await h.send(
      'post',
      `/api/lab-programs/${p.id}/close`,
      { version: await version('lab_program', p.id), idempotencyKey: newKey() },
      'pe',
    );
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(await pending('pe')).toBe(pendingBefore - 1);
    expect(await unread('pe')).toBe(unreadBefore);
    // Pat's old row is read live: resolved, no longer theirs.
    const [old] = await about('pe', closure);
    expect(old).toMatchObject({
      kind: 'action_request.opened',
      readAt: null,
      linkedRequest: {
        status: 'resolved',
        resolution: 'closed',
        resolvedBy: { userId: h.users.pe, initials: 'PE', name: 'Pat Example' },
        stillYours: false,
      },
    });
    expect(old!.linkedRequest!.resolvedAt).not.toBeNull();
    // The requester gets one decision notice.
    expect(await unread('tech')).toBe(techBefore + 1);
    const notices = await about('tech', closure);
    expect(notices).toMatchObject([
      {
        kind: 'action_request.decided',
        title: `Closure requested for ${p.programNumber}`,
        readAt: null,
        linkedRequest: { status: 'resolved', resolution: 'closed', stillYours: false },
      },
    ]);
    expect(await rows(closure)).toEqual([
      `action_request.decided ${h.users.tech}`,
      `action_request.opened ${h.users.pe}`,
    ]);
  });

  it('AC4: a self-resolved request gives no decision notice', async () => {
    const { testId } = await program();
    const own = await cancelRequest(testId, 'lm');
    await cancelTest(testId, 'lm');
    expect(await count(`FROM action_item WHERE id = $1 AND status = 'resolved'`, [own])).toBe(1);
    expect(await rows(own)).toEqual(opened(h.users.pe, h.users.lm, lou));
  });

  async function returnForCorrection(testId: string): Promise<string> {
    for (const to of ['in_progress', 'completed', 'review']) {
      const moved = await h.send(
        'post',
        `/api/test-requests/${testId}/status`,
        { idempotencyKey: newKey(), to, version: await version('test_request', testId) },
        'tech',
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    }
    const back = await h.send(
      'post',
      `/api/test-requests/${testId}/review`,
      {
        idempotencyKey: newKey(),
        action: 'return',
        comment: 'Recheck moisture',
        version: await version('test_request', testId),
      },
      'tech',
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const { rows: items } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM action_item WHERE kind = 'correction' AND entity_id = $1 AND status = 'open'`,
      [testId],
    );
    return items[0]!.id;
  }

  it('AC4: a correction resolved by cancelling the test is not "marked done": no notice', async () => {
    const { testId } = await program();
    const correction = await returnForCorrection(testId);
    await cancelTest(testId);
    expect(
      await count(`FROM action_item WHERE id = $1 AND status = 'resolved'`, [correction]),
    ).toBe(1);
    expect(await rows(correction)).toEqual(opened(h.users.lm, lou));
  });

  it('AC4: the reviewer who returned a correction is told once when it is marked done', async () => {
    const { testId } = await program();
    const correction = await returnForCorrection(testId);
    expect(await rows(correction)).toEqual(opened(h.users.lm, lou));

    const done = await h.send(
      'post',
      `/api/test-requests/${testId}/correction-done`,
      {
        idempotencyKey: newKey(),
        note: 'Fixed the entry',
        version: await version('test_request', testId),
      },
      'lm',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await about('tech', correction)).toMatchObject([
      {
        kind: 'action_request.decided',
        // The correction-done path records no resolution value on the item (MM-T25).
        linkedRequest: {
          kind: 'correction',
          status: 'resolved',
          resolvedBy: { userId: h.users.lm },
          stillYours: false,
        },
      },
    ]);
    expect(await rows(correction)).toEqual([
      `action_request.decided ${h.users.tech}`,
      ...opened(h.users.lm, lou),
    ]);
  });

  it('decision 4: reassignment gives the new person one row; old rows stay and read live', async () => {
    const { testId } = await program();
    const id = await cancelRequest(testId);
    const dana = await person('Dana Covering', 'DC', ['lab_manager']);
    expect(await rows(id)).toEqual(opened(h.users.pe, h.users.lm, lou));

    expect((await reassign(id, dana)).status).toBe(200);
    expect(await rows(id)).toEqual(opened(h.users.pe, h.users.lm, lou, dana));
    expect(await about(as(dana), id)).toMatchObject([{ linkedRequest: { stillYours: true } }]);
    for (const who of ['pe', 'lm', as(lou)]) {
      expect(await about(who, id)).toMatchObject([
        { linkedRequest: { status: 'open', stillYours: false } },
      ]);
    }
    // Back to Lee, then to Dana again: nobody gets a second row.
    expect((await reassign(id, h.users.lm, 'Lee takes it')).status).toBe(200);
    expect((await reassign(id, dana, 'Dana again')).status).toBe(200);
    expect(await rows(id)).toEqual(opened(h.users.pe, h.users.lm, lou, dana));
    expect(await about('lm', id)).toHaveLength(1);
  });

  it('decision 4 (D10): a lead change gives the new lead one row, and away-and-back adds none', async () => {
    const sam = await person('Sam Newlead', 'SN');
    const { program: p } = await program('b');
    const closure = await closeRequest(p.id);
    expect(await rows(closure)).toEqual(opened(h.users.pe));

    await setLead('b', sam, 'Pat moved to another office');
    expect(await rows(closure)).toEqual(opened(h.users.pe, sam));
    expect(await about('pe', closure)).toMatchObject([{ linkedRequest: { stillYours: false } }]);
    expect(await about(as(sam), closure)).toMatchObject([{ linkedRequest: { stillYours: true } }]);

    await setLead('b', h.users.pe, 'Pat returns');
    await setLead('b', sam, 'Sam again');
    await setLead('b', h.users.pe, 'Pat returns for good');
    expect(await rows(closure)).toEqual(opened(h.users.pe, sam));
    expect(await about('pe', closure)).toMatchObject([{ linkedRequest: { stillYours: true } }]);
  });

  it("recipient only: another person's notification is 404 and stays unchanged", async () => {
    const { program: p } = await program();
    const closure = await closeRequest(p.id);
    const [row] = await about('pe', closure);
    for (const path of ['read', 'dismiss', 'restore']) {
      const attempt = await mutate('lm', `${row!.id}/${path}`);
      expect(attempt.status, path).toBe(404);
      expect(attempt.body.code).toBe('notification_not_found');
      expect((await mutate('lm', `not-a-uuid/${path}`)).status).toBe(404);
      expect((await mutate('lm', `${newKey()}/${path}`)).status).toBe(404);
    }
    expect((await mutate('lm', 'read-all')).status).toBe(200);
    expect(await about('pe', closure)).toMatchObject([{ readAt: null, dismissedAt: null }]);
  });

  it('AC5: someone with no role or project authority gets no rows for items not routed to them', async () => {
    await closeRequest((await program()).program.id, 'js');
    expect(await count('FROM notification WHERE recipient_user_id = $1', [h.users.js])).toBe(0);
    expect(await list('js')).toEqual([]);
    expect(await unread('js')).toBe(0);
  });

  it('the list and count cover the last 90 days, newest first', async () => {
    const { program: p } = await program();
    const closure = await closeRequest(p.id);
    const later = await closeRequest((await program()).program.id);
    // Rows written directly for Jamie (no role): an old one and two recent ones.
    await h.db.pool.query(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key, created_at)
       VALUES ($1, 'action_request.opened', $2, $4, now() - interval '91 days'),
              ($1, 'action_request.decided', $2, $5, now() - interval '1 day'),
              ($1, 'action_request.opened', $3, $6, now())`,
      [
        h.users.jo,
        closure,
        later,
        `action_item:${closure}:opened`,
        `action_item:${closure}:decided`,
        `action_item:${later}:opened`,
      ],
    );
    const items = await list('jo', 'all');
    expect(items.map((n) => [n.kind, n.linkedRequest!.id])).toEqual([
      ['action_request.opened', later],
      ['action_request.decided', closure],
    ]);
    expect(await unread('jo')).toBe(2);
  });

  it('AC8: a LAB station gets 403 on every notification route, whoever it selects', async () => {
    const { program: p } = await program();
    const closure = await closeRequest(p.id);
    const [row] = await about('pe', closure);
    for (const station of [await h.cookie('lab'), await h.cookie('lab')]) {
      expect((await h.get('/api/notifications', station)).status).toBe(403);
      expect((await h.get('/api/notifications?filter=all', station)).status).toBe(403);
      expect((await h.get('/api/notifications/count', station)).status).toBe(403);
      for (const path of [`${row!.id}/read`, `${row!.id}/dismiss`, `${row!.id}/restore`]) {
        const attempt = await h.send(
          'post',
          `/api/notifications/${path}`,
          { actingStaffUserId: h.users.pe },
          station,
        );
        expect(attempt.status, path).toBe(403);
      }
      expect(
        (
          await h.send(
            'post',
            '/api/notifications/read-all',
            { actingStaffUserId: h.users.pe },
            station,
          )
        ).status,
      ).toBe(403);
    }
    expect(await about('pe', closure)).toMatchObject([{ readAt: null, dismissedAt: null }]);
    expect(await count('FROM notification WHERE recipient_user_id = $1', [h.users.lab])).toBe(0);
  });

  it('AC6: two concurrent resolutions give one decision notice', async () => {
    const { program: p, testId } = await program();
    const closure = await closeRequest(p.id);
    await cancelTest(testId);
    const current = await version('lab_program', p.id);
    const [a, b] = [await h.cookie('pe'), await h.cookie('pe')];
    const results = await Promise.all(
      [a, b].map((cookie) =>
        h.send(
          'post',
          `/api/lab-programs/${p.id}/close`,
          { version: current, idempotencyKey: newKey() },
          cookie,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(
      await count(
        `FROM notification WHERE action_item_id = $1 AND kind = 'action_request.decided'`,
        [closure],
      ),
    ).toBe(1);
  });

  it('AC9: notifications are written whatever the email preference; the outbox is unchanged (EMAIL_ENABLED false)', async () => {
    expect(
      notificationPreferencesSchema.parse(
        (await h.get('/api/me/notification-preferences', 'pe')).body,
      ).emailSendingEnabled,
    ).toBe(false);
    const outbox = async (itemId: string) =>
      (
        await h.db.pool.query<{ recipient_user_id: string; status: string }>(
          'SELECT recipient_user_id, status FROM email_outbox WHERE action_item_id = $1',
          [itemId],
        )
      ).rows;

    await emailPreference('pe', false);
    const quiet = await closeRequest((await program()).program.id);
    expect(await rows(quiet)).toEqual(opened(h.users.pe));
    expect(await outbox(quiet)).toEqual([]);

    await emailPreference('pe', true);
    const loud = await closeRequest((await program()).program.id);
    expect(await rows(loud)).toEqual(opened(h.users.pe));
    expect(await outbox(loud)).toEqual([{ recipient_user_id: h.users.pe, status: 'pending' }]);
    await emailPreference('pe', false);
  });
});
