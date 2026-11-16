import {
  INBOX_SORTS,
  INBOX_TABS,
  inboxPageSchema,
  inboxSummarySchema,
  type InboxItem,
  type InboxPage,
  type InboxSort,
  type InboxSummary,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { BADGE_UPDATES_DEFAULT } from './badge-preference.js';

// STRATA-25/54/55/57: the single Inbox feed over action requests and notifications, against real
// PostgreSQL. Fictional people and projects only (DEMO-2601 / DEMO-2602, Pat Example...).
//
// Fixture: Pat Example (`pe`) leads both projects.
//   hold      retention request on DEMO-2601 raised by Alex Tester, routed to Lee Manager (LM role)
//             and Pat (lead); both have its "opened" notice.
//   join      team join request on DEMO-2601 raised by Jordan Smith, routed to Pat.
//   lead      lead appointment on DEMO-2602 raised by Pat, routed to admins.
//   approved  retention request on DEMO-2602 raised by Alex, approved by Pat: Alex gets the
//             "decided" notice (the database trigger writes it).
// "No Initials" (`noInitials`) gets a bulk block for paging and sorting: 30 resolved requests they
// raised (all resolved in one statement, so their 30 "decided" notices share one timestamp) and
// 4 open ones.
describe.runIf(testDatabaseUrl)('Inbox feed (STRATA-25/54/55/57)', () => {
  let h: LabHarness;
  type As = Parameters<LabHarness['send']>[3];
  const ids = { hold: '', join: '', lead: '', approved: '' };
  let pendingCookie: string;
  const BULK_RESOLVED = 30;
  const BULK_OPEN = 4;

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

  async function opened(recipient: string, itemId: string) {
    await h.db.pool.query(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
       VALUES ($1, 'action_request.opened', $2, $3)`,
      [recipient, itemId, `action_item:${itemId}:opened`],
    );
  }

  async function feed(who: As, params: Record<string, string | number> = {}): Promise<InboxPage> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]): [string, string] => [key, String(value)]),
    );
    const response = await h.get(`/api/inbox?${query.toString()}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return inboxPageSchema.parse(response.body);
  }

  /** Every item of one tab, in one page. */
  const everything = async (who: As, params: Record<string, string | number> = {}) =>
    (await feed(who, { pageSize: 100, ...params })).items;

  async function summary(who: As): Promise<InboxSummary> {
    const response = await h.get('/api/inbox/summary', who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return inboxSummarySchema.parse(response.body);
  }

  async function mutate(who: As, path: string) {
    return h.send('post', `/api/inbox/${path}`, {}, who);
  }

  const find = (items: InboxItem[], sourceId: string) =>
    items.find((item) => item.type === 'request' && item.sourceId === sourceId);

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

  const statusOf = async (id: string) =>
    (
      await h.db.pool.query<{ status: string }>('SELECT status FROM action_item WHERE id = $1', [
        id,
      ])
    ).rows[0]!.status;

  beforeAll(async () => {
    h = await createLabHarness();
    ids.hold = await request('retention_request', h.projects.a, h.users.tech, 'Alex Tester');
    await opened(h.users.lm, ids.hold);
    await opened(h.users.pe, ids.hold);
    ids.join = await request('team_join_request', h.projects.a, h.users.js, 'Jordan Smith');
    await opened(h.users.pe, ids.join);
    ids.lead = await request('lead_appointment', h.projects.b, h.users.pe, 'Pat Example');
    await opened(h.users.admin, ids.lead);
    ids.approved = await request('retention_request', h.projects.b, h.users.tech, 'Alex Tester');
    await h.db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolution = 'approved', resolved_at = now(),
              resolved_by_user_id = $2 WHERE id = $1`,
      [ids.approved, h.users.pe],
    );

    // The bulk block for "No Initials".
    const bulk: string[] = [];
    for (let i = 0; i < BULK_RESOLVED + BULK_OPEN; i++) {
      const project = i % 3 === 0 ? h.projects.b : h.projects.a;
      bulk.push(await request('team_join_request', project, h.users.noInitials, 'No Initials'));
    }
    await h.db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolution = 'approved', resolved_at = now(),
              resolved_by_user_id = $2 WHERE id = ANY($1::uuid[])`,
      [bulk.slice(0, BULK_RESOLVED), h.users.pe],
    );

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

  it('shows open requests routed to me, folds opened notices into them, and carries the job number', async () => {
    const page = await feed('pe');
    const keys = page.items.map((item) => item.key);
    expect(keys).toContain(`request:${ids.hold}`);
    expect(keys).toContain(`request:${ids.join}`);
    // Pat raised the lead appointment: in All (open) though it waits on admins.
    expect(keys).toContain(`request:${ids.lead}`);
    // Opened notices are never rows of their own.
    expect(await everything('pe', { tab: 'updates' })).toEqual([]);
    const hold = find(page.items, ids.hold);
    expect(hold).toMatchObject({
      type: 'request',
      task: 'Retention',
      title: 'Hold requested for DEMO-2601 · whole project',
      projectId: h.projects.a,
      jobNumber: 'DEMO-2601',
      record: { kind: 'project', id: h.projects.a, label: 'DEMO-2601' },
      from: { userId: h.users.tech, name: 'Alex Tester' },
      unread: true,
      status: 'open',
      waitingOnMe: true,
      raisedByMe: false,
      stage: 'due',
      domain: 'retention',
    });
    expect(find(page.items, ids.lead)).toMatchObject({
      jobNumber: 'DEMO-2602',
      raisedByMe: true,
      waitingOnMe: false,
      // A request you raised starts read.
      unread: false,
    });
    // The resolved request Pat approved is in Done, not All.
    expect(keys).not.toContain(`request:${ids.approved}`);
    const done = await everything('pe', { tab: 'done' });
    expect(find(done, ids.approved)).toMatchObject({
      status: 'resolved',
      resolution: 'approved',
      resolvedBy: { userId: h.users.pe, name: 'Pat Example' },
      stage: 'closed',
    });
    expect(hold).toMatchObject({ resolvedBy: null });
    // Hold, join, and the four open join requests of the bulk block (Pat leads both projects).
    expect(page.summary.counts).toMatchObject({
      openRequests: BULK_OPEN + 2,
      unreadRequests: BULK_OPEN + 2,
      badge: BULK_OPEN + 2,
    });
  });

  it('shows the decided update to the person who raised it, with the resolver as sender', async () => {
    const updates = await everything('tech', { tab: 'updates' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: 'update',
      kind: 'action_request.decided',
      task: 'Your request was decided',
      title: 'Hold requested for DEMO-2602 · whole project',
      jobNumber: 'DEMO-2602',
      projectId: h.projects.b,
      from: { userId: h.users.pe, name: 'Pat Example' },
      unread: true,
      dismissed: false,
      aboutMyRequest: true,
      linkedRequestStatus: 'resolved',
      linkedResolution: 'approved',
    });
    const mine = await everything('tech', { filter: 'about_my_requests' });
    expect(mine.map((item) => item.key).sort()).toEqual(
      [`request:${ids.hold}`, updates[0]!.key].sort(),
    );
    // Waiting on me: Alex raised the hold but it waits on others.
    expect(await everything('tech', { filter: 'waiting_on_me' })).toEqual([]);
  });

  it('reading a request marks it and its opened notice read, never resolves it, and is per person', async () => {
    const before = (await summary('pe')).counts;
    const read = await mutate('pe', `requests/${ids.hold}/read`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const after = inboxSummarySchema.parse(read.body).counts;
    expect(after.badge).toBe(before.badge - 1);
    expect(after.openRequests).toBe(before.openRequests);
    expect(await statusOf(ids.hold)).toBe('open');
    expect(find(await everything('pe'), ids.hold)).toMatchObject({ unread: false, status: 'open' });
    const notices = await h.db.pool.query<{ recipient_user_id: string; read: boolean }>(
      `SELECT recipient_user_id, read_at IS NOT NULL AS read FROM notification
       WHERE action_item_id = $1 AND kind = 'action_request.opened'`,
      [ids.hold],
    );
    expect(Object.fromEntries(notices.rows.map((r) => [r.recipient_user_id, r.read]))).toEqual({
      [h.users.pe]: true,
      [h.users.lm]: false,
    });
    // Lee Manager still has it unread.
    expect(find(await everything('lm'), ids.hold)).toMatchObject({ unread: true });

    // Unread again: the request is unread, still open; the notice stays read.
    const unread = await mutate('pe', `requests/${ids.hold}/unread`);
    expect(unread.status).toBe(200);
    expect(inboxSummarySchema.parse(unread.body).counts.badge).toBe(before.badge);
    expect(find(await everything('pe'), ids.hold)).toMatchObject({ unread: true, status: 'open' });
    expect(await statusOf(ids.hold)).toBe('open');
    // Reading twice is fine.
    expect((await mutate('pe', `requests/${ids.join}/read`)).status).toBe(200);
    expect((await mutate('pe', `requests/${ids.join}/read`)).status).toBe(200);
    expect(await statusOf(ids.join)).toBe('open');
    // The raiser may mark their own request unread.
    expect((await mutate('pe', `requests/${ids.lead}/unread`)).status).toBe(200);
    expect(find(await everything('pe'), ids.lead)).toMatchObject({ unread: true });
  });

  it('a request reassigned to someone new arrives unread for them', async () => {
    expect((await mutate('lm', `requests/${ids.hold}/read`)).status).toBe(200);
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
      [h.users.jo],
    );
    const reassigned = await h.send(
      'post',
      `/api/action-items/${ids.hold}/reassign`,
      { toUserId: h.users.jo, reason: 'Covering the queue', idempotencyKey: newKey() },
      'admin',
    );
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    expect(find(await everything('jo'), ids.hold)).toMatchObject({
      unread: true,
      waitingOnMe: true,
    });
    expect(find(await everything('lm'), ids.hold)).toBeUndefined();
  });

  it('unread, read, dismissed, open and resolved are independent', async () => {
    const [update] = await everything('tech', { tab: 'updates' });
    expect(update).toMatchObject({ unread: true, dismissed: false });
    const dismissed = await h.send(
      'post',
      `/api/notifications/${update!.sourceId}/dismiss`,
      {},
      'tech',
    );
    expect(dismissed.status).toBe(200);
    // Dismissed: in Done, read, and its request stays resolved.
    expect(await everything('tech', { tab: 'updates' })).toEqual([]);
    const done = await everything('tech', { tab: 'done' });
    expect(done.find((item) => item.key === update!.key)).toMatchObject({
      dismissed: true,
      unread: false,
    });
    expect(await statusOf(ids.approved)).toBe('resolved');
    expect((await summary('tech')).counts.unreadUpdates).toBe(0);
    // Restore: back in Updates, still read.
    expect(
      (await h.send('post', `/api/notifications/${update!.sourceId}/restore`, {}, 'tech')).status,
    ).toBe(200);
    const restored = await everything('tech', { tab: 'updates' });
    expect(restored[0]).toMatchObject({ key: update!.key, dismissed: false, unread: false });
    // A resolved request can be unread in Done; reading it doesn't reopen it.
    const pending = find(await everything('pe', { tab: 'done' }), ids.approved);
    expect(pending).toMatchObject({ status: 'resolved', unread: true });
    expect((await mutate('pe', `requests/${ids.approved}/read`)).status).toBe(200);
    expect(find(await everything('pe', { tab: 'done' }), ids.approved)).toMatchObject({
      status: 'resolved',
      unread: false,
    });
  });

  it('read-all reads every unread item in the feed and resolves nothing', async () => {
    const statuses = await h.db.pool.query(
      'SELECT id, status, resolution FROM action_item ORDER BY id',
    );
    expect((await summary('pe')).counts.unread).toBeGreaterThan(0);
    const response = await mutate('pe', 'read-all');
    expect(response.status).toBe(200);
    const after = inboxSummarySchema.parse(response.body);
    expect(after.counts).toMatchObject({
      badge: 0,
      unread: 0,
      unreadRequests: 0,
      unreadUpdates: 0,
    });
    expect(after.counts.openRequests).toBeGreaterThan(0);
    expect(after.preview).toEqual([]);
    for (const tab of INBOX_TABS) {
      expect(
        (await everything('pe', { tab })).every((item) => !item.unread),
        tab,
      ).toBe(true);
    }
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification
       WHERE recipient_user_id = $1 AND kind = 'action_request.opened' AND read_at IS NULL`,
      [h.users.pe],
    );
    expect(rows[0]!.n).toBe(0);
    expect(
      (await h.db.pool.query('SELECT id, status, resolution FROM action_item ORDER BY id')).rows,
    ).toEqual(statuses.rows);
  });

  it('summary: badge counts unread requests waiting on me plus unread updates (badgeUpdates on by default)', async () => {
    expect(BADGE_UPDATES_DEFAULT).toBe(true);
    const s = await summary('noInitials');
    // 30 unread decided notices; the 4 open requests they raised wait on Pat and start read.
    expect(s.counts).toEqual({
      badge: BULK_RESOLVED,
      unread: BULK_RESOLVED,
      unreadRequests: 0,
      unreadUpdates: BULK_RESOLVED,
      openRequests: 0,
    });
    expect(s.preview).toHaveLength(3);
    const newest = (await everything('noInitials', { filter: 'unread' })).slice(0, 3);
    expect(s.preview).toEqual(newest);
  });

  it('summary: muting updates (badgeUpdates off) drops them from the badge but not from unread', async () => {
    const off = await h.send(
      'patch',
      '/api/me/preferences',
      { badgeUpdates: false, version: 0 },
      'noInitials',
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    try {
      expect((await summary('noInitials')).counts).toEqual({
        badge: 0,
        unread: BULK_RESOLVED,
        unreadRequests: 0,
        unreadUpdates: BULK_RESOLVED,
        openRequests: 0,
      });
    } finally {
      await h.db.pool.query(
        `DELETE FROM person_setting WHERE user_id = $1 AND area = 'preferences'`,
        [h.users.noInitials],
      );
    }
  });

  it('pages beyond page one with equal timestamps, in a fixed order with nothing skipped or repeated', async () => {
    const all = await everything('noInitials', { tab: 'updates' });
    expect(all).toHaveLength(BULK_RESOLVED);
    expect(new Set(all.map((item) => item.receivedAt)).size).toBe(1);
    // Equal times: the key decides.
    expect(all.map((item) => item.key)).toEqual(all.map((item) => item.key).sort());
    const walked: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const result = await feed('noInitials', { tab: 'updates', pageSize: 7, page });
      expect(result.total).toBe(BULK_RESOLVED);
      expect(result.items.length).toBe(page < 5 ? 7 : 2);
      walked.push(...result.items.map((item) => item.key));
    }
    expect(walked).toEqual(all.map((item) => item.key));
    expect((await feed('noInitials', { tab: 'updates', pageSize: 7, page: 6 })).items).toEqual([]);
  });

  describe('every sort', () => {
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    const primary: Record<InboxSort, ((item: InboxItem) => string | null) | null> = {
      newest: null,
      oldest: null,
      requests_first: (item) => (item.type === 'request' ? 'a' : 'b'),
      task_asc: (item) => item.task,
      task_desc: (item) => item.task,
      title_asc: (item) => item.title,
      title_desc: (item) => item.title,
      job_number_asc: (item) => item.jobNumber,
      job_number_desc: (item) => item.jobNumber,
      record_asc: (item) => item.record?.label ?? null,
      record_desc: (item) => item.record?.label ?? null,
      from_asc: (item) => item.from?.name || 'Material Mule',
      from_desc: (item) => item.from?.name || 'Material Mule',
    };

    it.each(INBOX_SORTS)(
      '%s: ordered, ties by received time then key, and pages agree',
      async (sort) => {
        // Done holds both resolved requests and (for Pat) the decided updates of other people: use
        // Pat's All + Done and No Initials' Done for variety.
        for (const [who, tab] of [
          ['noInitials', 'done'],
          ['pe', 'all'],
          ['pe', 'done'],
        ] as const) {
          const items = await everything(who, { tab, sort });
          const value = primary[sort];
          const direction = sort.endsWith('_desc') ? -1 : 1;
          for (let i = 1; i < items.length; i++) {
            const [a, b] = [items[i - 1]!, items[i]!];
            let order = 0;
            if (value) {
              const [va, vb] = [value(a), value(b)];
              if (va !== vb) {
                order = !va ? 1 : !vb ? -1 : collator.compare(va, vb) * direction;
              }
            }
            if (order === 0) {
              const received =
                sort === 'oldest'
                  ? a.receivedAt.localeCompare(b.receivedAt)
                  : b.receivedAt.localeCompare(a.receivedAt);
              order = received || (a.key < b.key ? -1 : 1);
            }
            expect(order, `${sort} ${who}/${tab} at ${i}`).toBeLessThanOrEqual(0);
          }
          const paged: string[] = [];
          for (let page = 1; page <= Math.ceil(items.length / 4); page++) {
            paged.push(
              ...(await feed(who, { tab, sort, pageSize: 4, page })).items.map((i) => i.key),
            );
          }
          expect(paged).toEqual(items.map((item) => item.key));
        }
      },
    );
  });

  it('searches title, job number, record and sender case-insensitively, and counts tabs for the same search', async () => {
    const byJob = await feed('noInitials', { tab: 'done', q: 'demo-2602', pageSize: 100 });
    expect(byJob.items.length).toBeGreaterThan(0);
    expect(byJob.items.every((item) => item.jobNumber === 'DEMO-2602')).toBe(true);
    const all = await everything('noInitials', { tab: 'done' });
    expect(byJob.total).toBe(all.filter((item) => item.jobNumber === 'DEMO-2602').length);
    // Tab counts follow the search too.
    const updates = await everything('noInitials', { tab: 'updates' });
    const in2602 = async (tab: string) =>
      (await everything('noInitials', { tab })).filter((item) => item.jobNumber === 'DEMO-2602')
        .length;
    expect(byJob.tabCounts).toEqual({
      all: await in2602('all'),
      requests: await in2602('requests'),
      updates: await in2602('updates'),
      done: byJob.total,
    });
    expect(byJob.tabCounts.requests).toBeGreaterThan(0);
    // Sender and title.
    const bySender = await everything('tech', { tab: 'updates', q: 'PAT EXAMPLE' });
    expect(bySender).toHaveLength(1);
    expect(await everything('tech', { q: 'hold requested' })).not.toEqual([]);
    expect(await everything('tech', { q: 'nothing like this' })).toEqual([]);
    // Without a search, tab counts cover every tab.
    const page = await feed('noInitials');
    expect(page.tabCounts).toEqual({
      all: BULK_RESOLVED + BULK_OPEN,
      requests: BULK_OPEN,
      updates: BULK_RESOLVED,
      done: BULK_RESOLVED,
    });
    // Filters combine with the search: unread and DEMO-2602.
    const unreadJob = await feed('noInitials', {
      filter: 'unread',
      q: 'DEMO-2602',
      tab: 'updates',
    });
    expect(unreadJob.total).toBe(updates.filter((item) => item.jobNumber === 'DEMO-2602').length);
  });

  it('rejects a bad query', async () => {
    for (const query of [
      'tab=inbox',
      'sort=sideways',
      'filter=mine',
      'page=0',
      'pageSize=101',
      'extra=1',
    ]) {
      const response = await h.get(`/api/inbox?${query}`, 'pe');
      expect(response.status, query).toBe(400);
    }
  });

  it('someone the request is not routed to (and who did not raise it) gets 404, and nothing changes', async () => {
    const before = await snapshot();
    for (const path of [
      `requests/${ids.lead}/read`,
      `requests/${ids.lead}/unread`,
      `requests/${ids.join}/read`,
      'requests/not-a-uuid/read',
      'requests/00000000-0000-4000-8000-00000000ffff/read',
    ]) {
      const response = await mutate('js', path);
      // Jordan raised the join request, so that one is theirs to mark.
      if (path === `requests/${ids.join}/read`) {
        expect(response.status, path).toBe(200);
        continue;
      }
      expect(response.status, path).toBe(404);
      expect(response.body.code).toBe('action_item_not_found');
    }
    // Only Jordan's own read of their join request changed anything.
    const { rows } = await h.db.pool.query(
      `SELECT action_item_id FROM inbox_request_read WHERE user_id = $1`,
      [h.users.js],
    );
    expect(rows).toEqual([{ action_item_id: ids.join }]);
    expect(await snapshot()).not.toBe(before);
    const settled = await snapshot();
    expect((await mutate('js', `requests/${ids.lead}/read`)).status).toBe(404);
    expect(await snapshot()).toBe(settled);
  });

  it('LAB and a pending account are refused on every Inbox route, and nothing changes', async () => {
    const before = await snapshot();
    for (const who of ['lab', pendingCookie] as As[]) {
      for (const [method, path] of [
        ['get', '/api/inbox'],
        ['get', '/api/inbox/summary'],
        ['post', '/api/inbox/read-all'],
        ['post', `/api/inbox/requests/${ids.hold}/read`],
        ['post', `/api/inbox/requests/${ids.hold}/unread`],
      ] as const) {
        const response =
          method === 'get' ? await h.get(path, who) : await h.send('post', path, {}, who);
        expect(response.status, `${String(who).slice(0, 12)} ${path}`).toBe(403);
      }
    }
    expect(await snapshot()).toBe(before);
  });
});
