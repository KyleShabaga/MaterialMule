import {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE_MAX,
  labProgramReviewSchema,
  labProgramSchema,
  notificationCountSchema,
  notificationListSchema,
  type NotificationList,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { encodeCursor } from './notifications.service.js';

// MM-T91 review follow-up: the notification list is paged with an opaque keyset cursor on
// (created_at, id), newest first, so every row in the 90-day window is reachable, including old
// dismissed rows someone may restore. 260 rows for Jamie Song (`jo`, no role) across 260 resolved
// closure requests of one fictional DEMO-2601 program, 120 of them sharing one exact timestamp;
// a few for Jordan Smith (`js`) interleaved to prove recipient isolation. Real PostgreSQL.
describe.runIf(testDatabaseUrl)('notification paging (MM-T91)', () => {
  let h: LabHarness;
  let programId: string;
  type As = Parameters<LabHarness['send']>[3];
  const TOTAL = 260;
  const SAME_INSTANT = 120;

  const FILTER_SQL = {
    all: 'true',
    active: 'dismissed_at IS NULL',
    unread: 'read_at IS NULL AND dismissed_at IS NULL',
  } as const;
  type Filter = keyof typeof FILTER_SQL;

  async function page(
    who: As,
    params: Record<string, string | number> = {},
  ): Promise<NotificationList> {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]): [string, string] => [key, String(value)]),
    );
    const response = await h.get(`/api/notifications?${query.toString()}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return notificationListSchema.parse(response.body);
  }

  /** Follows nextCursor to the end; fails if a page repeats a row or the walk doesn't end. */
  async function walk(who: As, filter: Filter, limit?: number) {
    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const result = await page(who, {
        filter,
        ...(limit ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
      sizes.push(result.items.length);
      ids.push(...result.items.map((n) => n.id));
      cursor = result.nextCursor;
      if (!cursor) return { ids, sizes };
    }
    throw new Error('paging did not end');
  }

  /** What the database says the list holds, in the API's order. */
  async function expected(userId: string, filter: Filter): Promise<string[]> {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM notification
       WHERE recipient_user_id = $1 AND created_at >= now() - interval '90 days'
         AND ${FILTER_SQL[filter]}
       ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    return rows.map((row) => row.id);
  }

  async function unread(who: As) {
    const response = await h.get('/api/notifications/count', who);
    expect(response.status).toBe(200);
    return notificationCountSchema.parse(response.body).unread;
  }

  const mutate = (who: As, path: string) => h.send('post', `/api/notifications/${path}`, {}, who);

  async function itemStates(): Promise<string> {
    const { rows } = await h.db.pool.query<{ state: string }>(
      `SELECT string_agg(id || ':' || status || ':' || coalesce(resolution, '-'), ',' ORDER BY id)
         AS state
       FROM action_item WHERE program_id = $1`,
      [programId],
    );
    return rows[0]!.state;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    const moisture = (await h.testType('MC-T91P', 'Moisture content (fictional)', 'Moisture')).id;
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-91P') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    await h.bucket({ project: 'a', hole: holeId });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
      },
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
    programId = labProgramSchema.parse(submitted.body).id;

    // Resolved closure requests (only open ones are unique per program), one per notification.
    const { rows: items } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_user_id, entity_type, entity_id, program_id,
                                project_id, created_by_user_id, created_by_name_snapshot, reason,
                                idempotency_key, request_hash, status, resolved_at,
                                resolved_by_user_id, resolution)
       SELECT 'closure_request', $2, 'lab_program', $1, $1, $3, $4, 'Alex Tester',
              'All tests are done', gen_random_uuid(), 'fictional-hash', 'resolved', now(), $2,
              'closed'
       FROM generate_series(1, $5)
       RETURNING id`,
      [programId, h.users.pe, h.projects.a, h.users.tech, TOTAL + 1],
    );
    const ids = items.map((row) => row.id);
    // Jamie: 120 rows at one exact instant, then one per minute going back, plus one row older
    // than 90 days that no page may show. Every 3rd is read; every 7th is read and dismissed.
    await h.db.pool.query(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key, created_at,
                                 read_at, dismissed_at)
       SELECT $1, 'action_request.opened', item.id, 'action_item:' || item.id || ':opened',
              CASE WHEN item.n <= $3 THEN timestamptz '2026-10-30 12:00:00.123456+00'
                   WHEN item.n <= $4
                     THEN timestamptz '2026-10-30 12:00:00.123456+00' - item.n * interval '1 minute'
                   ELSE now() - interval '91 days' END,
              CASE WHEN item.n % 3 = 0 OR item.n % 7 = 0 THEN now() END,
              CASE WHEN item.n % 7 = 0 THEN now() END
       FROM unnest($2::uuid[]) WITH ORDINALITY AS item(id, n)`,
      [h.users.jo, ids, SAME_INSTANT, TOTAL],
    );
    // Jordan: five rows at the same instant as Jamie's block, never visible to Jamie.
    await h.db.pool.query(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key, created_at)
       SELECT $1, 'action_request.opened', id, 'action_item:' || id || ':opened',
              timestamptz '2026-10-30 12:00:00.123456+00'
       FROM unnest($2::uuid[]) AS id`,
      [h.users.js, ids.slice(0, 5)],
    );
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('pages through more than 200 rows in a fixed order with no row skipped or repeated', async () => {
    const all = await expected(h.users.jo, 'all');
    expect(all).toHaveLength(TOTAL);
    const big = await walk('jo', 'all', NOTIFICATION_PAGE_SIZE_MAX);
    expect(big.sizes).toEqual([100, 100, 60]);
    expect(big.ids).toEqual(all);
    // The default page size, and a page boundary that falls inside the equal-timestamp block.
    const small = await walk('jo', 'all');
    expect(small.sizes[0]).toBe(NOTIFICATION_PAGE_SIZE);
    expect(small.ids).toEqual(all);
    const odd = await walk('jo', 'all', 37);
    expect(new Set(odd.ids).size).toBe(TOTAL);
    expect(odd.ids).toEqual(all);
  });

  it('pages every filter, and the 91-day-old row never appears', async () => {
    for (const filter of ['active', 'unread'] as const) {
      const want = await expected(h.users.jo, filter);
      expect(want.length, filter).toBeGreaterThan(100);
      expect((await walk('jo', filter, 41)).ids, filter).toEqual(want);
    }
    const old = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM notification WHERE recipient_user_id = $1
         AND created_at < now() - interval '90 days'`,
      [h.users.jo],
    );
    expect(old.rows).toHaveLength(1);
    expect((await walk('jo', 'all', 100)).ids).not.toContain(old.rows[0]!.id);
  });

  it("recipient only: Jordan pages only Jordan's rows, even with a cursor from Jamie's list", async () => {
    const jordan = await expected(h.users.js, 'all');
    expect(jordan).toHaveLength(5);
    expect((await walk('js', 'all', 2)).ids).toEqual(jordan);
    const jamie = await page('jo', { filter: 'all', limit: 3 });
    const borrowed = await page('js', { filter: 'all', cursor: jamie.nextCursor! });
    for (const n of borrowed.items) expect(jordan).toContain(n.id);
  });

  it('a notification that arrives between pages shifts nothing on the next page', async () => {
    const want = await expected(h.users.jo, 'all');
    const first = await page('jo', { filter: 'all', limit: 30 });
    expect(first.items.map((n) => n.id)).toEqual(want.slice(0, 30));
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_user_id, entity_type, entity_id, program_id,
                                project_id, created_by_user_id, created_by_name_snapshot, reason,
                                idempotency_key, request_hash, status, resolved_at,
                                resolved_by_user_id, resolution)
       VALUES ('closure_request', $2, 'lab_program', $1, $1, $3, $4, 'Alex Tester',
               'All tests are done', gen_random_uuid(), 'fictional-hash', 'resolved', now(), $2,
               'closed')
       RETURNING id`,
      [programId, h.users.pe, h.projects.a, h.users.tech],
    );
    const arrived = rows[0]!.id;
    await h.db.pool.query(
      `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
       VALUES ($1, 'action_request.opened', $2::uuid, 'action_item:' || $2::text || ':opened')`,
      [h.users.jo, arrived],
    );
    const second = await page('jo', { filter: 'all', limit: 30, cursor: first.nextCursor! });
    expect(second.items.map((n) => n.id)).toEqual(want.slice(30, 60));
    // A fresh first page shows it at the top.
    const fresh = await page('jo', { filter: 'all', limit: 1 });
    expect(fresh.items[0]!.linkedRequest!.id).toBe(arrived);
  });

  it('after reading a page, the next page and a reloaded first page bring the older unread rows; the count agrees', async () => {
    const before = await itemStates();
    const unreadBefore = await expected(h.users.jo, 'unread');
    expect(await unread('jo')).toBe(unreadBefore.length);
    const first = await page('jo', { filter: 'unread', limit: 50 });
    for (const n of first.items) expect((await mutate('jo', `${n.id}/read`)).status).toBe(200);
    // The cursor still points after the rows just read: the next page is the next 50 unread.
    const next = await page('jo', { filter: 'unread', limit: 50, cursor: first.nextCursor! });
    expect(next.items.map((n) => n.id)).toEqual(unreadBefore.slice(50, 100));
    // Reloading from the top refills with the same older unread rows.
    const reloaded = await page('jo', { filter: 'unread', limit: 50 });
    expect(reloaded.items.map((n) => n.id)).toEqual(unreadBefore.slice(50, 100));
    expect(await unread('jo')).toBe(unreadBefore.length - 50);
    expect((await walk('jo', 'unread', 100)).ids).toEqual(unreadBefore.slice(50));
    // Reading never touched an action item.
    expect(await itemStates()).toBe(before);
  });

  it('the oldest dismissed rows, past the first 200, can be reached and restored', async () => {
    const before = await itemStates();
    const all = await expected(h.users.jo, 'all');
    const dismissed = (
      await h.db.pool.query<{ id: string }>(
        `SELECT id FROM notification WHERE recipient_user_id = $1 AND dismissed_at IS NOT NULL
           AND created_at >= now() - interval '90 days'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [h.users.jo],
      )
    ).rows[0]!.id;
    expect(all.indexOf(dismissed)).toBeGreaterThan(200);
    const walked = await walk('jo', 'all', 100);
    expect(walked.ids).toContain(dismissed);
    const unreadBefore = await unread('jo');
    expect((await mutate('jo', `${dismissed}/restore`)).status).toBe(200);
    expect((await walk('jo', 'active', 100)).ids).toContain(dismissed);
    // A dismissed row is always read, so restoring it leaves the unread count alone.
    expect(await unread('jo')).toBe(unreadBefore);
    expect(await itemStates()).toBe(before);
  });

  it('mark all read reaches every unread row, not only the first page', async () => {
    const before = await itemStates();
    // Unread rows span several default-size pages, so the first page alone is not all of them.
    const unreadBefore = await walk('jo', 'unread');
    expect(unreadBefore.sizes.length).toBeGreaterThan(1);
    expect(await unread('jo')).toBe(unreadBefore.ids.length);
    const response = await mutate('jo', 'read-all');
    expect(response.status).toBe(200);
    expect(notificationCountSchema.parse(response.body).unread).toBe(0);
    expect(await walk('jo', 'unread', 100)).toEqual({ ids: [], sizes: [0] });
    const left = await h.db.pool.query(
      'SELECT 1 FROM notification WHERE recipient_user_id = $1 AND read_at IS NULL',
      [h.users.jo],
    );
    expect(left.rows).toEqual([]);
    // Jordan's rows are untouched.
    expect(await unread('js')).toBe(5);
    expect(await itemStates()).toBe(before);
  });

  it('refuses a bad filter, limit, cursor or extra parameter with a 400 code', async () => {
    const cases: [string, string][] = [
      ['filter=bogus', 'invalid_filter'],
      ['limit=0', 'invalid_limit'],
      [`limit=${NOTIFICATION_PAGE_SIZE_MAX + 1}`, 'invalid_limit'],
      ['limit=abc', 'invalid_limit'],
      ['limit=2.5', 'invalid_limit'],
      ['cursor=not-a-cursor', 'invalid_cursor'],
      [`cursor=${Buffer.from('2026-10-30|x').toString('base64url')}`, 'invalid_cursor'],
      [`cursor=${'a'.repeat(201)}`, 'invalid_cursor'],
      ['page=2', 'invalid_query'],
    ];
    for (const [query, code] of cases) {
      const response = await h.get(`/api/notifications?${query}`, 'jo');
      expect(response.status, query).toBe(400);
      expect(response.body.code, query).toBe(code);
    }
    // A well-formed cursor past every row is simply an empty last page.
    const past = encodeCursor({ at: '2000-01-01T00:00:00.000000Z', id: newKey() });
    expect(await page('jo', { filter: 'all', cursor: past })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
