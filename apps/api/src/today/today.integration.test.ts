import { randomUUID } from 'node:crypto';
import {
  inboxPageSchema,
  needsYouResponseSchema,
  scopedActivityItemSchema,
  type NeedsYouResponse,
} from '@materialmule/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordAudit } from '../audit/audit.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { ConcreteHoldsService } from '../concrete/concrete-holds.service.js';
import { withTransaction } from '../db/transaction.js';
import { BusinessClock } from '../retention/business-clock.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { insertProject, insertReceipt, insertTestHole } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-56 Needs you and STRATA-23 activity scopes, against real PostgreSQL with direct API
// calls. Fictional data only: DEMO-2601 (A) and DEMO-2602 (B) led by Pat Example (`pe`),
// DEMO-2603 led by Jordan Smith (`js`); Lee Manager (`lm`) Lab Manager; Alex Tester (`tech`)
// no role.
describe.runIf(testDatabaseUrl)(
  'Today: needs you and activity scopes (STRATA-56, STRATA-23)',
  () => {
    let h: LabHarness;
    let clock: BusinessClock;
    let pendingCookie: string;
    let projectC: string;
    type As = Parameters<LabHarness['send']>[3];

    /** Buckets received 2026-10-23 reach the end of retention on 2027-10-23. */
    const at = (date: string) => clock.set(new Date(`${date}T18:00:00Z`));

    async function oldBucket(project: 'a' | 'b' = 'a') {
      const hole = await insertTestHole(
        h.db.pool,
        h.projects[project],
        `TH-${newKey().slice(0, 8)}`,
      );
      return h.bucket({ project, hole, receivedDate: '2026-10-23' });
    }

    async function needsYou(as: As): Promise<NeedsYouResponse> {
      const response = await h.get('/api/today/needs-you', as);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return needsYouResponseSchema.parse(response.body);
    }

    const row = (list: NeedsYouResponse, key: string) => list.items.find((i) => i.key === key);

    /** Everything a read could have changed by mistake. */
    async function snapshot(): Promise<string> {
      const { rows } = await h.db.pool.query<{ state: string }>(
        `SELECT concat_ws('|',
         (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM action_item),
         (SELECT string_agg(user_id || ':' || action_item_id || ':' || coalesce(read_at::text, '-'),
                            ',' ORDER BY user_id, action_item_id) FROM inbox_request_read),
         (SELECT string_agg(id || ':' || coalesce(read_at::text, '-'), ',' ORDER BY id)
          FROM notification),
         (SELECT count(*)::text FROM audit_event),
         (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM storage_unit)) AS state`,
      );
      return rows[0]!.state;
    }

    // A complete concrete field report, as the review queue tests make them (invented values).
    const SPEC = {
      specifiedStrengthMpa: 32,
      slumpTargetMm: 80,
      slumpToleranceMm: 30,
      airMinPercent: 5,
      airMaxPercent: 8,
      maxAggregateSizeMm: 20,
      cementType: 'GU',
    };
    const completeFields = () => ({
      reportDate: '2026-11-08',
      contractorName: 'Example Builders',
      locationElements: ['Footing'],
      locationDescription: 'Grid A-3',
      supplierName: 'Example Ready-Mix',
      mixNumber: '0042',
      ticketNumber: `T-${randomUUID().slice(0, 8)}`,
      truckNumber: 'T-7',
      plantName: 'North Plant',
      batchedAt: '2026-11-08T15:00:00.000Z',
      loadVolumeM3: 8,
      cumulativeVolumeM3: 24,
      projectSpec: SPEC,
      ticketSpec: SPEC,
      arrivedAt: '2026-11-08T15:20:00.000Z',
      sampledAt: '2026-11-08T15:30:00.000Z',
      testedAt: '2026-11-08T15:35:00.000Z',
      timeLimitExceeded: false,
      loadRejected: false,
      loadDecisionByName: 'Sam Example',
      loadDecisionByCompany: 'Example Builders',
      samplingLocation: 'chute',
      placementMethods: ['chute'],
      material: 'concrete',
      superplasticizerAdded: 'none',
      concreteTempC: 18,
      ambientTempC: -4,
      waterAdded: false,
      specimensCast: false,
      resultsReportedToName: 'Sam Example',
      resultsReportedToCompany: 'Example Builders',
      readings: [
        { id: randomUUID(), test: 'slump', context: 'initial', value: 90 },
        { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
      ],
      attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
    });

    /** A field report drafted and submitted by `as` on project A. */
    async function submittedReport(as: As): Promise<string> {
      const drafted = await h.send(
        'post',
        `/api/concrete/projects/${h.projects.a}/field-reports`,
        { idempotencyKey: newKey(), ...completeFields() },
        as,
      );
      expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
      const { id, version } = drafted.body as { id: string; version: number };
      const submitted = await h.send(
        'post',
        `/api/concrete/field-reports/${id}/submit`,
        { idempotencyKey: newKey(), version },
        as,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      return id;
    }

    beforeAll(async () => {
      h = await createLabHarness();
      clock = h.app.get(BusinessClock);
      projectC = await insertProject(h.db.pool, 'DEMO-2603', h.users.js);
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Pending Person', 'PP', 'personal', 'pending') RETURNING id`,
      );
      const session = await h.app.get(SessionService).create(rows[0]!.id, 'personal');
      pendingCookie = `${SESSION_COOKIE}=${session.token}`;
    }, 120_000);

    afterEach(() => {
      clock.set(null);
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await h?.close();
    });

    it('LAB and pending accounts get 403 from needs-you, and nothing changes', async () => {
      const before = await snapshot();
      const lab = await h.get('/api/today/needs-you', 'lab');
      expect(lab.status).toBe(403);
      expect(lab.body).toMatchObject({ code: 'forbidden' });
      const pending = await h.get('/api/today/needs-you', pendingCookie);
      expect(pending.status).toBe(403);
      expect(pending.body).toMatchObject({ code: 'access_pending' });
      expect(await snapshot()).toBe(before);
    });

    it('a clear day: nothing needs an ordinary account', async () => {
      expect(await needsYou('tech')).toEqual({
        items: [],
        total: 0,
        fromInbox: 0,
        unavailable: [],
      });
    });

    it('requests appear once in Inbox wording; a retention request stands for its units; disposal follows authority', async () => {
      at('2027-10-24');
      const u1 = await oldBucket();
      const u2 = await oldBucket();
      // On Jordan's project: never in Pat's "my projects".
      const projectCHole = await insertTestHole(h.db.pool, projectC, 'TH26-01');
      expect(projectCHole).toBeTruthy();

      let pat = await needsYou('pe');
      expect(row(pat, 'system:retention_due')).toMatchObject({
        source: 'system',
        title: 'Decide on 2 units at end of retention',
        ids: [u1.readableId, u2.readableId],
        count: 2,
        stage: 'due',
        domain: 'retention',
        action: 'Decide',
        href: '/disposal-retention',
      });
      // Not Pat's to decide elsewhere, and not the technician's at all.
      expect(row(await needsYou('tech'), 'system:retention_due')).toBeUndefined();
      expect(row(await needsYou('js'), 'system:retention_due')).toBeUndefined();

      const asked = await h.send(
        'post',
        '/api/retention/requests',
        {
          kind: 'hold',
          projectId: h.projects.a,
          scope: 'units',
          unitIds: [u1.id],
          reason: 'Client may want more tests',
          idempotencyKey: newKey(),
        },
        'tech',
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);

      const before = await snapshot();
      pat = await needsYou('pe');
      expect(await snapshot()).toBe(before);
      const inbox = inboxPageSchema.parse((await h.get('/api/inbox?pageSize=100', 'pe')).body);
      const waiting = inbox.items.filter(
        (i) => i.type === 'request' && i.status === 'open' && i.waitingOnMe,
      );
      expect(waiting).toHaveLength(1);
      const requests = pat.items.filter((i) => i.source === 'request');
      expect(requests).toHaveLength(1);
      const [request] = requests;
      const [fromInbox] = waiting;
      expect(request).toMatchObject({
        key: fromInbox!.key,
        task: fromInbox!.task,
        title: fromInbox!.title,
        stage: fromInbox!.stage,
        domain: fromInbox!.domain,
        href: fromInbox!.href,
        count: 1,
      });
      expect(new Set(pat.items.map((i) => i.key)).size).toBe(pat.items.length);
      // The unit the request is about isn't listed twice; the other one still is.
      expect(row(pat, 'system:retention_due')).toMatchObject({
        title: 'Decide on 1 unit at end of retention',
        ids: [u2.readableId],
        count: 1,
      });
      expect(pat.fromInbox).toBe(1);
      expect(pat.total).toBe(pat.items.length);
      // Same rank (due): the request comes before system work.
      expect(pat.items.indexOf(request!)).toBeLessThan(
        pat.items.indexOf(row(pat, 'system:retention_due')!),
      );

      // Approved units: the Lab Manager's to start disposing of; no longer the lead's to decide.
      expect(row(await needsYou('lm'), 'system:disposal_approved')).toBeUndefined();
      const approved = await h.send(
        'post',
        '/api/disposal/approvals',
        { unitIds: [u2.id], idempotencyKey: newKey() },
        'lm',
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(201);
      expect(row(await needsYou('lm'), 'system:disposal_approved')).toMatchObject({
        title: '1 unit approved for disposal',
        ids: [u2.readableId],
        action: 'Start disposal',
        href: '/disposal-retention/scan',
      });
      // Pat leads the project but has no Lab Manager role: no lab-wide disposal row.
      pat = await needsYou('pe');
      expect(row(pat, 'system:disposal_approved')).toBeUndefined();
      expect(row(pat, 'system:retention_due')).toBeUndefined();
    });

    it('concrete reviews: the lead sees others’ reports, never their own; a non-lead sees none', async () => {
      await submittedReport('tech');
      const pat = await needsYou('pe');
      expect(row(pat, 'system:concrete_reviews')).toMatchObject({
        title: 'Review 1 concrete report',
        ids: ['DEMO-2601'],
        count: 1,
        href: '/concrete/review',
      });
      expect(row(await needsYou('js'), 'system:concrete_reviews')).toBeUndefined();
      expect(row(await needsYou('tech'), 'system:concrete_reviews')).toBeUndefined();
      // The Lab Manager role is no review authority (no concrete grant, not the lead).
      expect(row(await needsYou('lm'), 'system:concrete_reviews')).toBeUndefined();

      // Pat's own report never waits on Pat.
      await submittedReport('pe');
      expect(row(await needsYou('pe'), 'system:concrete_reviews')).toMatchObject({ count: 1 });
    });

    it('a failing source lands in unavailable and the rest still return', async () => {
      vi.spyOn(h.app.get(ConcreteHoldsService), 'list').mockRejectedValue(new Error('down'));
      const lm = await needsYou('lm');
      expect(lm.unavailable).toEqual(['concrete_holds']);
      expect(lm.items.some((i) => i.key === 'system:concrete_holds')).toBe(false);
      // Sources the person has no authority for are never called, so never unavailable.
      const tech = await needsYou('tech');
      expect(tech.unavailable).toEqual([]);
    });

    it('activity scopes: lab is everything, projects keeps my projects, mine keeps what I did', async () => {
      const receiptA = await insertReceipt(h.db.pool, h.projects.a, h.users.tech);
      const receiptC = await insertReceipt(h.db.pool, projectC, h.users.pe);
      const event = async (actor: 'tech' | 'pe', receiptId: string, projectNumber: string) =>
        withTransaction(h.db.pool, (client) =>
          recordAudit(client, {
            action: 'receipt.confirmed',
            entityType: 'receipt',
            entityId: receiptId,
            actor: {
              userId: h.users[actor],
              accountType: 'personal',
              initials: actor === 'pe' ? 'PE' : 'AT',
              name: actor === 'pe' ? 'Pat Example' : 'Alex Tester',
            },
            after: { readableIds: ['BKT-2026-000901'], projectNumber },
          }),
        );
      const techOnA = await event('tech', receiptA, 'DEMO-2601');
      const patOnC = await event('pe', receiptC, 'DEMO-2603');

      const recent = async (as: As, scope?: string) => {
        const response = await h.get(
          `/api/activity/recent?limit=50${scope ? `&scope=${scope}` : ''}`,
          as,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (response.body as unknown[])
          .map((item) => scopedActivityItemSchema.parse(item))
          .filter((item) => item.id === techOnA || item.id === patOnC);
      };

      const lab = await recent('pe');
      expect(lab.map((i) => i.id).sort()).toEqual([techOnA, patOnC].sort());
      expect(lab.find((i) => i.id === patOnC)!.byMe).toBe(true);
      expect(lab.find((i) => i.id === techOnA)!.byMe).toBe(false);
      expect((await recent('pe', 'lab')).length).toBe(2);
      // Pat leads A, not C.
      expect((await recent('pe', 'projects')).map((i) => i.id)).toEqual([techOnA]);
      expect((await recent('pe', 'mine')).map((i) => i.id)).toEqual([patOnC]);
      // Jordan leads C.
      expect((await recent('js', 'projects')).map((i) => i.id)).toEqual([patOnC]);
      // Alex is on no project.
      expect(await recent('tech', 'projects')).toEqual([]);
      expect((await recent('tech', 'mine')).map((i) => i.id)).toEqual([techOnA]);

      // LAB: the whole lab only, never "mine" or "projects", and never byMe.
      const labLedger = await recent('lab');
      expect(labLedger).toHaveLength(2);
      expect(labLedger.every((i) => !i.byMe)).toBe(true);
      const before = await snapshot();
      for (const scope of ['mine', 'projects']) {
        const refused = await h.get(`/api/activity/recent?scope=${scope}`, 'lab');
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({ code: 'scope_not_available' });
      }
      expect((await h.get('/api/activity/recent?scope=everyone', 'pe')).status).toBe(400);
      expect(await snapshot()).toBe(before);
    });
  },
);
