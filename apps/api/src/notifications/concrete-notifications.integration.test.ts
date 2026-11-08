import { randomUUID } from 'node:crypto';
import {
  concreteFieldReportDetailSchema,
  notificationCountSchema,
  notificationListSchema,
  type ConcreteFieldReportDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-V2-C29: concrete notifications (card AC1–AC3; test plan T2). A reviewer returning a field
// report notifies its technician and the Lab Manager(s), never the reviewer, one row per person,
// with MM-T91 read state. Real PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A,
// led by Pat Example `pe`), invented reviewers, suppliers and tickets. The request helpers below
// follow the C09 lifecycle suite.
describe.runIf(testDatabaseUrl)('concrete notifications (MM-V2-C29)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  /** A designated field reviewer on A. */
  let rv: string;
  /** A designated field reviewer on A who also holds the Lab Manager role. */
  let rvLm: string;

  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: string) =>
    h
      .http()
      [method](url)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as] ?? as)
      .send(body as object);
  const get = async (url: string, as: string) =>
    h
      .http()
      .get(url)
      .set('Cookie', cookies[as] ?? as);
  const reportPath = (id: string, rest = '') => `/api/concrete/field-reports/${id}${rest}`;

  async function person(name: string, initials: string) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, initials],
    );
    const id = rows[0]!.id;
    const session = await h.app.get(SessionService).create(id, 'personal');
    cookies[id] = `${SESSION_COOKIE}=${session.token}`;
    return id;
  }

  async function designatedReviewer(name: string, initials: string) {
    const id = await person(name, initials);
    const ok = (r: { status: number; body: unknown }) =>
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    ok(
      await send(
        'post',
        `/api/staff/${id}/reviewer-eligibility`,
        { scopeCode: 'concrete_field', reason: 'Certified', idempotencyKey: newKey() },
        'admin',
      ),
    );
    ok(
      await send(
        'post',
        `/api/projects/${h.projects.a}/team-members`,
        { userId: id, reason: 'On the project', idempotencyKey: newKey() },
        'admin',
      ),
    );
    const assigned = await send(
      'post',
      `/api/projects/${h.projects.a}/reviewer-assignments`,
      {
        reviewerUserId: id,
        scopeCode: 'concrete_field',
        reason: 'Reviews field reports',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    ok(assigned);
    const assignment = (
      assigned.body as { active: { id: string; reviewer: { userId: string } }[] }
    ).active.find((a) => a.reviewer.userId === id)!.id;
    ok(
      await send(
        'post',
        `/api/projects/${h.projects.a}/reviewer-assignments/${assignment}/approval`,
        { idempotencyKey: newKey() },
        'pe',
      ),
    );
    return id;
  }

  const SPEC = {
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    airMinPercent: 5,
    airMaxPercent: 8,
    maxAggregateSizeMm: 20,
    cementType: 'GU',
  };

  /** Every field the final review needs (C04's list), fictional values. */
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

  async function completeReport(
    as = 'tech',
    fields: Record<string, unknown> = completeFields(),
    requireComplete = true,
  ) {
    const created = await send(
      'post',
      `/api/concrete/projects/${h.projects.a}/field-reports`,
      { idempotencyKey: newKey(), ...fields },
      as,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const report = concreteFieldReportDetailSchema.parse(created.body);
    if (requireComplete) expect(report.completeness.missingRequired).toEqual([]);
    return report;
  }

  const command = (
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
    key = newKey(),
  ) =>
    send(
      'post',
      reportPath(report.id, `/${action}`),
      { idempotencyKey: key, version: report.version, ...extra },
      as,
    );

  async function ok(
    action: string,
    report: Pick<ConcreteFieldReportDetail, 'id' | 'version'>,
    as: string,
    extra: Record<string, unknown> = {},
  ) {
    // MM-V2-C28: Mark reviewed needs every exception on the version resolved or documented.
    // These tests are about notifications, so the setup records the notes directly.
    if (action === 'review') {
      await h.db.pool.query(
        `INSERT INTO concrete_report_exception_note
           (project_id, field_report_id, version_id, code, field, note, documented_by_user_id)
         SELECT v.project_id, v.field_report_id, v.id, w->>'code', w->>'field',
                'Documented in test setup', $2
         FROM concrete_report_version v
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.snapshot->'warnings', '[]')) w
         WHERE v.field_report_id = $1 AND v.state = 'submitted'
         ON CONFLICT DO NOTHING`,
        [report.id, h.users.pe],
      );
    }
    const response = await command(action, report, as, extra);
    expect(response.status, `${action}: ${JSON.stringify(response.body)}`).toBe(201);
    return concreteFieldReportDetailSchema.parse(response.body);
  }

  /** Every notification row for a report, as (recipient, kind) pairs. */
  async function noticesFor(reportId: string) {
    const { rows } = await h.db.pool.query<{ recipient: string; kind: string }>(
      `SELECT recipient_user_id AS recipient, kind FROM notification
       WHERE concrete_field_report_id = $1 ORDER BY created_at, recipient_user_id`,
      [reportId],
    );
    return rows;
  }

  async function submitted(as = 'tech') {
    return ok('submit', await completeReport(as), as);
  }

  const returnBody = { comment: 'Fictional: slump time is missing' };

  const list = async (as: string, filter = 'active') =>
    notificationListSchema.parse((await get(`/api/notifications?filter=${filter}`, as)).body);
  const unread = async (as: string) =>
    notificationCountSchema.parse((await get('/api/notifications/count', as)).body).unread;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab'] as const) {
      cookies[key] = await h.cookie(key);
    }
    rv = await designatedReviewer('Riley Reviewer', 'RR');
    rvLm = await designatedReviewer('Morgan Manager', 'MM');
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
      [rvLm],
    );
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('T2: a return notifies the technician and every Lab Manager when the project grants none', async () => {
    const report = await submitted();
    const before = await unread('tech');
    await ok('return', report, rv, returnBody);
    const rows = await noticesFor(report.id);
    expect(rows.map((r) => r.recipient).sort()).toEqual([h.users.tech, h.users.lm, rvLm].sort());
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['concrete_report.returned']));
    // Never the reviewer who returned it; never email.
    expect(rows.some((r) => r.recipient === rv)).toBe(false);
    const { rows: outbox } = await h.db.pool.query(
      'SELECT 1 FROM email_outbox WHERE recipient_user_id = ANY($1::uuid[])',
      [[h.users.tech, h.users.lm, rvLm]],
    );
    expect(outbox).toEqual([]);
    expect(await unread('tech')).toBe(before + 1);
  });

  it('T2: the technician sees the report, its state, reviewer and comment; read state works', async () => {
    const report = await submitted();
    await ok('return', report, rv, returnBody);
    const item = (await list('tech')).items.find((n) => n.linkedReport?.id === report.id)!;
    expect(item).toMatchObject({
      kind: 'concrete_report.returned',
      title: 'Field report returned for correction',
      projectId: h.projects.a,
      projectNumber: 'DEMO-2601',
      href: `/concrete/review/${report.id}?version=1`,
      readAt: null,
      linkedRequest: null,
      linkedReport: {
        id: report.id,
        kind: 'field',
        state: 'returned',
        reportDate: '2026-11-08',
        versionNo: 1,
        by: { userId: rv, initials: 'RR', name: 'Riley Reviewer' },
        comment: returnBody.comment,
      },
    });
    const start = await unread('tech');
    const read = await send('post', `/api/notifications/${item.id}/read`, {}, 'tech');
    expect(read.status).toBe(200);
    expect(notificationCountSchema.parse(read.body).unread).toBe(start - 1);
    expect((await send('post', `/api/notifications/${item.id}/dismiss`, {}, 'tech')).status).toBe(
      200,
    );
    expect((await list('tech')).items.some((n) => n.id === item.id)).toBe(false);
    const all = await list('tech', 'all');
    expect(all.items.find((n) => n.id === item.id)?.dismissedAt).not.toBeNull();
    expect((await send('post', `/api/notifications/${item.id}/restore`, {}, 'tech')).status).toBe(
      200,
    );
    // Recipient-only: another person's notification is 404.
    expect((await send('post', `/api/notifications/${item.id}/read`, {}, 'js')).status).toBe(404);
  });

  it('the linked state is live: a resubmitted report no longer reads as returned', async () => {
    const report = await submitted();
    const returned = await ok('return', report, rv, returnBody);
    await ok('resubmit', returned, 'tech');
    const item = (await list('tech')).items.find((n) => n.linkedReport?.id === report.id)!;
    expect(item.linkedReport).toMatchObject({ state: 'submitted', versionNo: 1 });
  });

  it('AC1: a Lab Manager who returns the report gets no separate Lab Manager notice', async () => {
    const report = await submitted();
    await ok('return', report, rvLm, returnBody);
    const recipients = (await noticesFor(report.id)).map((r) => r.recipient).sort();
    expect(recipients).toEqual([h.users.tech, h.users.lm].sort());
    expect(recipients).not.toContain(rvLm);
  });

  it('AC2: a technician who is also a Lab Manager gets one notice; retries add nothing', async () => {
    // Lee Manager (lm) writes and submits the report: technician and Lab Manager at once.
    const report = await submitted('lm');
    const key = newKey();
    const first = await command('return', report, rv, returnBody, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await command('return', report, rv, returnBody, key);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const rows = await noticesFor(report.id);
    expect(rows.filter((r) => r.recipient === h.users.lm)).toHaveLength(1);
    expect(rows.map((r) => r.recipient).sort()).toEqual([h.users.lm, rvLm].sort());
  });

  it('a second return (of the resubmitted version) is a new notice', async () => {
    const report = await submitted();
    const returned = await ok('return', report, rv, returnBody);
    const resubmitted = await ok('resubmit', returned, 'tech');
    await ok('return', resubmitted, rv, { comment: 'Fictional: air reading still missing' });
    const forTech = (await noticesFor(report.id)).filter((r) => r.recipient === h.users.tech);
    expect(forTech).toHaveLength(2);
    const items = (await list('tech')).items.filter((n) => n.linkedReport?.id === report.id);
    expect(items.map((n) => n.linkedReport?.versionNo).sort()).toEqual([1, 2]);
  });

  it('other lifecycle commands notify no one', async () => {
    const report = await submitted();
    await ok('review', report, rv);
    expect(await noticesFor(report.id)).toEqual([]);
  });

  it('LAB and disabled accounts never receive one; LAB still has no notifications route', async () => {
    const report = await submitted();
    await ok('return', report, rv, returnBody);
    const recipients = (await noticesFor(report.id)).map((r) => r.recipient);
    expect(recipients).not.toContain(h.users.lab);
    expect(recipients).not.toContain(h.users.disabled);
    expect((await get('/api/notifications', 'lab')).status).toBe(403);
  });

  // Last: a project grant narrows the Lab Managers for every later return on A.
  it('C29 Q1 proposal: with a project concrete Lab Manager grant, only granted Lab Managers are told', async () => {
    await h.db.pool.query(
      `INSERT INTO project_concrete_lab_manager_grant (project_id, lab_manager_user_id,
         lab_manager_name_snapshot, granted_by_user_id, granted_by_name_snapshot, grant_reason,
         grant_idempotency_key, grant_request_hash)
       VALUES ($1, $2, 'Morgan Manager', $3, 'Admin Example', 'Fictional grant', $4, 'hash')`,
      [h.projects.a, rvLm, h.users.admin, randomUUID()],
    );
    const report = await submitted();
    await ok('return', report, rv, returnBody);
    expect((await noticesFor(report.id)).map((r) => r.recipient).sort()).toEqual(
      [h.users.tech, rvLm].sort(),
    );
  });
});
