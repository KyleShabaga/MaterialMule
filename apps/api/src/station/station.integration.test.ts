import {
  DEFAULT_STATION_ROWS,
  concreteAddDays,
  concreteLabToday,
  inboxPageSchema,
  inboxSummarySchema,
  meResponseSchema,
  stationConfigSchema,
  stationInboxPageSchema,
  stationInboxSummarySchema,
  stationTodaySchema,
  type StationConfig,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { DatabaseService } from '../database/database.service.js';
import { InboxService } from '../inbox/inbox.service.js';

// Strata lane A: the LAB station's Today counts (STRATA-20/21/63), its configuration (migration
// 0048) and the consent-based, read-only station Inbox (STRATA-27). Real PostgreSQL, direct API
// calls. Fictional people and projects only (DEMO-2601, Pat Example, Alex Tester, Lee Manager).
describe.runIf(testDatabaseUrl)('LAB station API (Strata lane A)', () => {
  let h: LabHarness;
  let labTechCookie: string;
  let labTechId: string;
  const STATION = 'station-demo-0001';
  const OTHER_STATION = 'station-demo-0002';

  const json = (body: unknown) => JSON.stringify(body);

  async function setPreferences(userId: string, value: Record<string, unknown>) {
    await h.db.pool.query(
      `INSERT INTO person_setting (user_id, area, value) VALUES ($1, 'preferences', $2::jsonb)
       ON CONFLICT (user_id, area) DO UPDATE SET value = EXCLUDED.value, version = person_setting.version + 1`,
      [userId, JSON.stringify(value)],
    );
  }

  /** Everything a station call could change: config, audit, read state and requests. */
  async function snapshot(): Promise<string> {
    const { rows } = await h.db.pool.query<{ state: string }>(
      `SELECT concat_ws('|',
         (SELECT string_agg(station_id || ':' || version || ':' || rows::text, ',' ORDER BY station_id)
          FROM station_config),
         (SELECT count(*)::text FROM audit_event),
         (SELECT string_agg(user_id || ':' || action_item_id || ':' || coalesce(read_at::text, '-'),
                            ',' ORDER BY user_id, action_item_id) FROM inbox_request_read),
         (SELECT string_agg(id || ':' || coalesce(read_at::text, '-') || ':'
                            || coalesce(dismissed_at::text, '-'), ',' ORDER BY id) FROM notification),
         (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM action_item),
         (SELECT string_agg(user_id || ':' || area || ':' || version, ',' ORDER BY user_id, area)
          FROM person_setting)) AS state`,
    );
    return rows[0]!.state;
  }

  async function putConfig(as: string, body: unknown, station = STATION) {
    const cookie = as.startsWith(SESSION_COOKIE) ? as : await h.cookie(as as PersonKey);
    return h
      .http()
      .put(`/api/station/config/${station}`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);
  }

  const reversed = () =>
    [...DEFAULT_STATION_ROWS].reverse().map((r, i) => ({ row: r.row, visible: i !== 0 }));

  beforeAll(async () => {
    h = await createLabHarness();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Taylor Bench', 'TB', 'personal', 'active') RETURNING id`,
    );
    labTechId = rows[0]!.id;
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_technician')`,
      [labTechId],
    );
    const session = await h.app.get(SessionService).create(labTechId, 'personal');
    labTechCookie = `${SESSION_COOKIE}=${session.token}`;

    // Requests routed to Pat (pe) and to Alex (tech), each with its "opened" notice.
    for (const [target, raiser] of [
      [h.users.pe, h.users.js],
      [h.users.tech, h.users.jo],
    ] as const) {
      const { rows: item } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_role, entity_type, entity_id, target_user_id,
                                  project_id, created_by_user_id, created_by_name_snapshot, reason,
                                  idempotency_key, request_hash)
         VALUES ('team_join_request', NULL, 'team_join_request', gen_random_uuid(), $1, $2, $3,
                 'Jordan Smith', 'Fictional reason', gen_random_uuid(), 'hash')
         RETURNING id`,
        [target, h.projects.a, raiser],
      );
      await h.db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, action_item_id, event_key)
         VALUES ($1, 'action_request.opened', $2, $3)`,
        [target, item[0]!.id, `action_item:${item[0]!.id}:opened`],
      );
    }
    // Pat shares; Alex turned it off; Lee Manager never saved preferences.
    await setPreferences(h.users.pe, { shareInboxOnStations: true });
    await setPreferences(h.users.tech, { shareInboxOnStations: false });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  describe('GET /api/station/today', () => {
    it('gives LAB and lab staff the counts; an ordinary internal user is refused', async () => {
      for (const who of ['lab', 'lm', labTechCookie]) {
        const response = await h.get('/api/station/today', who);
        expect(response.status, json(response.body)).toBe(200);
        stationTodaySchema.parse(response.body);
      }
      for (const who of ['tech', 'pe']) {
        const response = await h.get('/api/station/today', who);
        expect(response.status).toBe(403);
        expect(response.body).toEqual(expect.objectContaining({ code: 'forbidden' }));
      }
    });

    it('counts LAB drafts not deleted, breaks due today untested and labels to print', async () => {
      const today = concreteLabToday();
      // Drafts: two open on LAB, one deleted on LAB, one on a personal account (not counted).
      const drafts = [newKey(), newKey(), newKey(), newKey()];
      for (const [i, id] of drafts.entries()) {
        const account = i === 3 ? h.users.tech : h.users.lab;
        await h.db.pool.query(
          `INSERT INTO receipt_draft_registry (draft_id, account_user_id, starter_user_id)
           VALUES ($1, $2, $3)`,
          [id, account, h.users.tech],
        );
      }
      await h.db.pool.query(
        `UPDATE receipt_draft_registry SET deleted_at = now(), deleted_by_account_user_id = $2,
                deleted_by_user_id = $3 WHERE draft_id = $1`,
        [drafts[2], h.users.lab, h.users.tech],
      );

      // Breaks: a set cast 7 days ago has its 7-day specimen due today.
      const report = await h.send(
        'post',
        `/api/concrete/projects/${h.projects.a}/field-reports`,
        {
          idempotencyKey: newKey(),
          material: 'concrete',
          specimensCast: true,
          castAt: `${concreteAddDays(today, -7)}T08:00:00-07:00`,
        },
        'tech',
      );
      expect(report.status, json(report.body)).toBe(201);
      const set = await h.send(
        'post',
        `/api/concrete/field-reports/${(report.body as { id: string }).id}/specimen-sets`,
        { idempotencyKey: newKey() },
        'tech',
      );
      expect(set.status, json(set.body)).toBe(201);
      const worklist = await h.get(`/api/concrete/lab-worklist?on=${today}`, 'tech');
      expect(worklist.status).toBe(200);
      const dueToday = (worklist.body as { counts: { today: number } }).counts.today;
      expect(dueToday).toBeGreaterThan(0);

      // Labels: never printed (counts), failed (counts), sent (doesn't), received long ago (doesn't).
      const never = await h.bucket({ hole: h.holes.a1, receivedDate: today });
      const failed = await h.bucket({ hole: h.holes.a1, receivedDate: today });
      const sent = await h.bucket({ hole: h.holes.a1, receivedDate: today });
      await h.bucket({ hole: h.holes.a1, receivedDate: concreteAddDays(today, -45) });
      // Jobs written directly, finished, on a printer that is turned off (the worker never runs them).
      const port = await FakeZebraPrinter.unusedPort();
      await h.db.pool.query(
        `INSERT INTO printer (key, name, host, port, is_default, enabled)
         VALUES ('receiving', 'Receiving ZD621', '127.0.0.1', $1, true, false)`,
        [port],
      );
      for (const [unit, status] of [
        [failed, 'failed'],
        [sent, 'sent'],
      ] as const) {
        await h.db.pool.query(
          `WITH job AS (
             INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                    requested_by_name_snapshot, status, attempts, sent_at)
             VALUES ('initial', 'receiving', 'v1', $2, 'Admin Example', $3, 1,
                     CASE WHEN $3 = 'sent' THEN now() END)
             RETURNING id)
           INSERT INTO print_job_item (print_job_id, storage_unit_id, position)
           SELECT id, $1, 1 FROM job`,
          [unit.id, h.users.admin, status],
        );
      }
      expect(never.id).toBeTruthy();

      const response = await h.get('/api/station/today', 'lab');
      expect(response.status, json(response.body)).toBe(200);
      expect(stationTodaySchema.parse(response.body)).toEqual({
        draftReceipts: 2,
        breaksDueToday: dueToday,
        labelsToPrint: 2,
      });
    });

    it('counts only open LAB drafts: never confirmed, expired or past the auto-delete age', async () => {
      const count = async () => {
        const response = await h.get('/api/station/today', 'lab');
        expect(response.status, json(response.body)).toBe(200);
        return stationTodaySchema.parse(response.body).draftReceipts;
      };
      const before = await count();
      const insert = (id: string, age = 0) =>
        h.db.pool.query(
          `INSERT INTO receipt_draft_registry (draft_id, account_user_id, starter_user_id, created_at)
           VALUES ($1, $2, $3, now() - make_interval(days => $4::int))`,
          [id, h.users.lab, h.users.tech, age],
        );
      const [open, confirmed, expired, old] = [newKey(), newKey(), newKey(), newKey()];
      await insert(open);
      await insert(confirmed);
      await insert(expired);
      await insert(old, 45);
      for (const [id, reason] of [
        [confirmed, 'confirmed'],
        [expired, 'expired'],
      ] as const) {
        await h.db.pool.query(
          `UPDATE receipt_draft_registry SET closed_at = now(), closed_reason = $2
           WHERE draft_id = $1`,
          [id, reason],
        );
      }
      // Clean-up off (the default): nothing is deleted for age, so the old draft still counts.
      expect(await count()).toBe((before ?? 0) + 2);
      // Clean-up on at 30 days: the 45-day-old draft was deleted by its browser, even offline.
      await h.db.pool.query(`UPDATE draft_auto_delete_setting SET enabled = true, after_days = 30`);
      try {
        expect(await count()).toBe((before ?? 0) + 1);
      } finally {
        await h.db.pool.query(
          `UPDATE draft_auto_delete_setting SET enabled = false, after_days = 90`,
        );
      }
    });

    it('answers null for a count that fails and still returns the others', async () => {
      const pool = h.app.get(DatabaseService).pool;
      const original = pool.query.bind(pool);
      const spy = vi.spyOn(pool, 'query').mockImplementation(((
        text: unknown,
        ...rest: unknown[]
      ) => {
        if (typeof text === 'string' && text.includes('receipt_draft_registry')) {
          return Promise.reject(new Error('simulated failure'));
        }
        return (original as (...args: unknown[]) => unknown)(text, ...rest);
      }) as typeof pool.query);
      try {
        const response = await h.get('/api/station/today', 'lab');
        expect(response.status, json(response.body)).toBe(200);
        const body = stationTodaySchema.parse(response.body);
        expect(body.draftReceipts).toBeNull();
        expect(body.breaksDueToday).not.toBeNull();
        expect(body.labelsToPrint).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('station configuration', () => {
    it('reads the defaults for a station never saved, for every active session', async () => {
      for (const who of ['lab', 'tech', 'lm']) {
        const response = await h.get(`/api/station/config/${OTHER_STATION}`, who);
        expect(response.status, json(response.body)).toBe(200);
        expect(stationConfigSchema.parse(response.body)).toEqual({
          stationId: OTHER_STATION,
          rows: DEFAULT_STATION_ROWS,
          version: 0,
          updatedBy: null,
          updatedAt: null,
        });
      }
      expect((await h.get('/api/station/config/bad id', 'lab')).status).toBe(400);
    });

    it('refuses LAB whoever is picked, and a technician, changing nothing', async () => {
      const before = await snapshot();
      for (const who of ['lab', 'tech', labTechCookie, 'admin']) {
        const response = await putConfig(who, {
          rows: reversed(),
          version: 0,
          personUserId: h.users.lm,
        });
        expect(response.status, json(response.body)).toBe(403);
        expect(response.body).toEqual(expect.objectContaining({ code: 'forbidden' }));
      }
      expect(await snapshot()).toBe(before);
    });

    it('lets a Lab Manager with their own account save; each save adds one and is audited', async () => {
      const first = await putConfig('lm', { rows: reversed(), version: 0 });
      expect(first.status, json(first.body)).toBe(200);
      const saved = stationConfigSchema.parse(first.body);
      expect(saved).toMatchObject({
        stationId: STATION,
        rows: reversed(),
        version: 1,
        updatedBy: { userId: h.users.lm, name: 'Lee Manager' },
      });
      const second = await putConfig('lm', { rows: DEFAULT_STATION_ROWS, version: 1 });
      expect(second.status, json(second.body)).toBe(200);
      expect(stationConfigSchema.parse(second.body)).toMatchObject({
        version: 2,
        rows: DEFAULT_STATION_ROWS,
      });
      const read = await h.get(`/api/station/config/${STATION}`, 'lab');
      expect(stationConfigSchema.parse(read.body).version).toBe(2);
      const { rows } = await h.db.pool.query(
        `SELECT actor_user_id, after_values FROM audit_event
         WHERE action = 'station_config.saved' ORDER BY occurred_at`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        actor_user_id: h.users.lm,
        after_values: { stationId: STATION, version: 2 },
      });
    });

    it('answers a stale version with 409 and the current config, saving nothing', async () => {
      const current = stationConfigSchema.parse(
        (await h.get(`/api/station/config/${STATION}`, 'lm')).body,
      );
      const before = await snapshot();
      const response = await putConfig('lm', { rows: reversed(), version: current.version - 1 });
      expect(response.status).toBe(409);
      const body = response.body as { code: string; current: StationConfig };
      expect(body.code).toBe('version_conflict');
      expect(stationConfigSchema.parse(body.current)).toEqual(current);
      expect(await snapshot()).toBe(before);
    });

    it('refuses a body that does not list every row once', async () => {
      const before = await snapshot();
      const response = await putConfig('lm', {
        rows: [DEFAULT_STATION_ROWS[0], DEFAULT_STATION_ROWS[0], DEFAULT_STATION_ROWS[1]],
        version: 2,
      });
      expect(response.status).toBe(400);
      expect(await snapshot()).toBe(before);
    });

    it('lists station.configure in /api/me only for the Lab Manager', async () => {
      const permissions = async (who: string) =>
        meResponseSchema.parse((await h.get('/api/me', who)).body).permissions;
      expect(await permissions('lm')).toContain('station.configure');
      for (const who of ['lab', 'tech', 'admin', labTechCookie]) {
        expect(await permissions(who)).not.toContain('station.configure');
      }
      expect(await permissions('lab')).toEqual(
        expect.arrayContaining(['station.today.read', 'station.inbox.read']),
      );
      expect(await permissions('lm')).not.toContain('station.inbox.read');
    });
  });

  describe('station Inbox (STRATA-27)', () => {
    const page = (personId: string, as = 'lab', extra = '') =>
      h.get(`/api/station/inbox?personId=${personId}${extra}`, as);
    const summary = (personId: string, as = 'lab') =>
      h.get(`/api/station/inbox/summary?personId=${personId}`, as);

    it('refuses personal accounts, changing nothing', async () => {
      const before = await snapshot();
      for (const who of ['pe', 'lm', 'admin', 'tech']) {
        for (const response of [await page(h.users.pe, who), await summary(h.users.pe, who)]) {
          expect(response.status).toBe(403);
          expect(Object.keys(response.body as object)).not.toContain('page');
        }
      }
      expect(await snapshot()).toBe(before);
    });

    it("never opens LAB's way into the personal Inbox and notification routes", async () => {
      const before = await snapshot();
      for (const path of [
        '/api/notifications',
        '/api/inbox',
        '/api/inbox/summary',
        `/api/inbox?personId=${h.users.pe}`,
      ]) {
        expect((await h.get(path, 'lab')).status, path).toBe(403);
      }
      expect(await snapshot()).toBe(before);
    });

    it('answers private with no items or counts when the person has not opted in', async () => {
      for (const person of [h.users.tech, h.users.lm]) {
        const listed = await page(person);
        expect(listed.status, json(listed.body)).toBe(200);
        const parsed = stationInboxPageSchema.parse(listed.body);
        expect(parsed.state).toBe('private');
        expect(Object.keys(listed.body as object).sort()).toEqual(['person', 'state']);
        const counted = await summary(person);
        expect(counted.status).toBe(200);
        expect(Object.keys(counted.body as object).sort()).toEqual(['person', 'state']);
      }
    });

    it("returns an opted-in person's own feed, read-only", async () => {
      const own = inboxPageSchema.parse((await h.get('/api/inbox', 'pe')).body);
      const ownSummary = inboxSummarySchema.parse((await h.get('/api/inbox/summary', 'pe')).body);
      expect(own.total).toBeGreaterThan(0);
      const before = await snapshot();
      const listed = stationInboxPageSchema.parse((await page(h.users.pe)).body);
      expect(listed).toEqual({
        state: 'shared',
        person: { userId: h.users.pe, name: 'Pat Example' },
        page: own,
      });
      const counted = stationInboxSummarySchema.parse((await summary(h.users.pe)).body);
      expect(counted).toEqual({
        state: 'shared',
        person: { userId: h.users.pe, name: 'Pat Example' },
        summary: ownSummary,
      });
      expect(await snapshot()).toBe(before);
      // The usual query parameters apply.
      const done = stationInboxPageSchema.parse((await page(h.users.pe, 'lab', '&tab=done')).body);
      expect(done.state === 'shared' && done.page.items).toEqual([]);
      expect((await page(h.users.pe, 'lab', '&tab=nope')).body).toEqual(
        expect.objectContaining({ code: 'invalid_tab' }),
      );
    });

    it("switching personId returns the other person's state, never cached", async () => {
      const pat = stationInboxPageSchema.parse((await page(h.users.pe)).body);
      const alex = stationInboxPageSchema.parse((await page(h.users.tech)).body);
      expect(pat.state).toBe('shared');
      expect(alex).toEqual({
        state: 'private',
        person: { userId: h.users.tech, name: 'Alex Tester' },
      });
      // Alex turns it on: the very next call shows Alex's own feed, not Pat's.
      await setPreferences(h.users.tech, { shareInboxOnStations: true });
      const alexOn = stationInboxPageSchema.parse((await page(h.users.tech)).body);
      const alexOwn = inboxPageSchema.parse((await h.get('/api/inbox', 'tech')).body);
      expect(alexOn).toEqual({
        state: 'shared',
        person: { userId: h.users.tech, name: 'Alex Tester' },
        page: alexOwn,
      });
      expect(alexOwn.items.map((i) => i.sourceId)).not.toEqual(
        pat.state === 'shared' ? pat.page.items.map((i) => i.sourceId) : [],
      );
      await setPreferences(h.users.tech, { shareInboxOnStations: false });
      expect(stationInboxPageSchema.parse((await page(h.users.tech)).body).state).toBe('private');
    });

    it('answers 404 with no detail for an unknown, disabled or LAB person', async () => {
      for (const id of [newKey(), h.users.disabled, h.users.lab]) {
        for (const response of [await page(id), await summary(id)]) {
          expect(response.status).toBe(404);
          expect(response.body).toEqual(expect.objectContaining({ code: 'person_not_found' }));
          expect(json(response.body)).not.toContain('Former Staff');
        }
      }
      expect((await page('not-a-uuid')).body).toEqual(
        expect.objectContaining({ code: 'invalid_personId' }),
      );
    });

    it('never builds the feed by acting as the person', async () => {
      const inbox = h.app.get(InboxService);
      const pageSpy = vi.spyOn(inbox, 'page');
      const pageFor = vi.spyOn(inbox, 'pageFor');
      try {
        await page(h.users.pe);
        expect(pageSpy).not.toHaveBeenCalled();
        expect(pageFor).toHaveBeenCalledWith(h.users.pe, expect.anything());
      } finally {
        pageSpy.mockRestore();
        pageFor.mockRestore();
      }
    });
  });
});
