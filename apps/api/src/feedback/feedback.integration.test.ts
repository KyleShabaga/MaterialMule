import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  feedbackListSchema,
  inboxPageSchema,
  notificationListSchema,
  submitFeedbackResponseSchema,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { feedbackPagePath } from './feedback.service.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';

// Help & Feedback: anyone active sends feedback; it is kept as an audit event on the host and
// only administrators read it. Fictional people only.

describe.runIf(testDatabaseUrl)('POST/GET /api/feedback', () => {
  let db: TestSchema;
  let app: INestApplication;
  let staffCookie: string;
  let adminCookie: string;
  let pendingCookie: string;
  let managerCookie: string;
  let secondAdminCookie: string;
  let labCookie: string;
  const people: Record<string, string> = {};

  async function userWithSession(
    name: string,
    initials: string,
    status: 'active' | 'pending' | 'disabled',
    role?: string,
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
    people[initials] = rows[0]!.id;
    if (role) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    const session = await app.get(SessionService).create(rows[0]!.id, 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  const send = (cookie: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/feedback')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);

  const feedbackCount = async () =>
    Number(
      (
        await db.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_event WHERE action = 'feedback.submitted'`,
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    staffCookie = await userWithSession('Alex Tester', 'AT', 'active');
    adminCookie = await userWithSession('Kit Admin', 'KA', 'active', 'admin');
    pendingCookie = await userWithSession('Riley Applicant', 'RA', 'pending');
    managerCookie = await userWithSession('Mo Manager', 'MM', 'active', 'lab_manager');
    secondAdminCookie = await userWithSession('Sam Admin', 'SA', 'active', 'admin');
    // A disabled admin gets nothing.
    await userWithSession('Dee Former', 'DF', 'disabled', 'admin');
    const { rows: labRows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
    );
    const lab = await app.get(SessionService).create(labRows[0]!.id, 'shared_lab');
    labCookie = `${SESSION_COOKIE}=${lab.token}`;
  });

  const noticesFor = async (eventId: string) =>
    (
      await db.pool.query<{ recipient_user_id: string }>(
        `SELECT recipient_user_id FROM notification
         WHERE kind = 'feedback.submitted' AND feedback_event_id = $1
         ORDER BY recipient_user_id`,
        [eventId],
      )
    ).rows.map((row) => row.recipient_user_id);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('keeps feedback from an active person as an audit event, path only', async () => {
    const response = await send(staffCookie, {
      kind: 'confusing',
      text: '  The move screen asks for the shelf twice.  ',
      page: '/sample-storage/move',
    });
    expect(response.status).toBe(201);
    const { id } = submitFeedbackResponseSchema.parse(response.body);
    const { rows } = await db.pool.query<{
      entity_type: string;
      actor_name_snapshot: string;
      after_values: Record<string, unknown>;
    }>('SELECT entity_type, actor_name_snapshot, after_values FROM audit_event WHERE id = $1', [
      id,
    ]);
    expect(rows[0]).toMatchObject({
      entity_type: 'feedback',
      actor_name_snapshot: 'Alex Tester',
      after_values: {
        kind: 'confusing',
        text: 'The move screen asks for the shelf twice.',
        page: '/sample-storage/move',
      },
    });
  });

  it('refuses a blank text, an unknown kind, a page with a query string and extra fields', async () => {
    const before = await feedbackCount();
    for (const body of [
      {},
      { kind: 'idea', text: '   ' },
      { kind: 'complaint', text: 'Hello' },
      { kind: 'idea', text: 'Hello', page: '/sample-storage?search=DEMO-2601' },
      { kind: 'idea', text: 'Hello', page: 'https://example.test/' },
      { kind: 'idea', text: 'Hello', email: 'someone@example.test' },
      { kind: 'idea', text: 'x'.repeat(2001) },
    ]) {
      expect((await send(staffCookie, body)).status).toBe(400);
    }
    expect(await feedbackCount()).toBe(before);
  });

  it('refuses a pending account and changes nothing', async () => {
    const before = await feedbackCount();
    expect((await send(pendingCookie, { kind: 'idea', text: 'Hello' })).status).toBe(403);
    expect(await feedbackCount()).toBe(before);
  });

  it('lets administrators read it, newest first, and nobody else', async () => {
    await send(staffCookie, { kind: 'idea', text: 'Show the shelf on the label.' });
    expect(
      (await request(app.getHttpServer()).get('/api/feedback').set('Cookie', staffCookie)).status,
    ).toBe(403);
    const response = await request(app.getHttpServer())
      .get('/api/feedback')
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    const list = feedbackListSchema.parse(response.body);
    expect(list[0]).toMatchObject({
      kind: 'idea',
      text: 'Show the shelf on the label.',
      name: 'Alex Tester',
      initials: 'AT',
      page: null,
    });
    expect(list.map((item) => item.kind)).toContain('confusing');
  });

  it('STRATA-118: a Lab Manager, LAB and a technician cannot read feedback', async () => {
    for (const cookie of [managerCookie, labCookie, staffCookie]) {
      const response = await request(app.getHttpServer())
        .get('/api/feedback')
        .set('Cookie', cookie);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'forbidden' });
    }
  });

  it('STRATA-104: each submission notifies every active administrator once, nobody else', async () => {
    const response = await send(staffCookie, {
      kind: 'not_working',
      text: 'The label preview is blank.',
      page: '/receiving',
    });
    expect(response.status).toBe(201);
    const { id } = submitFeedbackResponseSchema.parse(response.body);
    expect(await noticesFor(id)).toEqual([people.KA!, people.SA!].sort());

    // The administrator's Inbox shows a Feedback item with the page, never the text.
    const inbox = await request(app.getHttpServer())
      .get('/api/inbox?tab=updates')
      .set('Cookie', adminCookie);
    expect(inbox.status).toBe(200);
    const item = inboxPageSchema
      .parse(inbox.body)
      .items.find((i) => i.type === 'update' && i.record?.id === id);
    expect(item).toMatchObject({
      task: 'Feedback',
      title: 'Feedback · Problem',
      record: { kind: 'page', id, label: '/receiving' },
      from: { userId: people.AT, name: 'Alex Tester', initials: 'AT' },
      href: '/help',
      domain: 'feedback',
      stage: 'due',
      unread: true,
    });
    expect(JSON.stringify(inbox.body)).not.toContain('The label preview is blank.');

    const notices = await request(app.getHttpServer())
      .get('/api/notifications')
      .set('Cookie', secondAdminCookie);
    const notice = notificationListSchema
      .parse(notices.body)
      .items.find(
        (n) => n.kind === 'feedback.submitted' && n.linkedFeedback?.page === '/receiving',
      );
    expect(notice).toMatchObject({
      title: 'Feedback · Problem',
      href: '/help',
      linkedFeedback: { kind: 'not_working', page: '/receiving' },
    });

    // A Lab Manager's Inbox has none.
    const managerInbox = await request(app.getHttpServer())
      .get('/api/inbox?tab=all')
      .set('Cookie', managerCookie);
    expect(managerInbox.status).toBe(200);
    expect(JSON.stringify(managerInbox.body)).not.toContain('feedback.submitted');
  });

  it('STRATA-104: an administrator is not notified of their own feedback; LAB feedback notifies', async () => {
    const own = submitFeedbackResponseSchema.parse(
      (await send(adminCookie, { kind: 'idea', text: 'Bigger buttons.' })).body,
    );
    expect(await noticesFor(own.id)).toEqual([people.SA!]);
    const lab = await send(labCookie, { kind: 'confusing', text: 'Which shelf?', page: '/move' });
    expect(lab.status).toBe(201);
    expect(await noticesFor(submitFeedbackResponseSchema.parse(lab.body).id)).toEqual(
      [people.KA!, people.SA!].sort(),
    );
  });

  it('STRATA-104: a replayed submissionId returns the first submission and notifies nobody again', async () => {
    const submissionId = randomUUID();
    const body = { kind: 'idea', text: 'Remember my printer.', submissionId };
    const before = await feedbackCount();
    const first = submitFeedbackResponseSchema.parse((await send(staffCookie, body)).body);
    const again = await send(staffCookie, body);
    expect(again.status).toBe(201);
    expect(submitFeedbackResponseSchema.parse(again.body).id).toBe(first.id);
    expect(await feedbackCount()).toBe(before + 1);
    expect(await noticesFor(first.id)).toHaveLength(2);
    // Someone else's submission with the same id is their own.
    const other = await send(managerCookie, body);
    expect(submitFeedbackResponseSchema.parse(other.body).id).not.toBe(first.id);
    expect(await feedbackCount()).toBe(before + 2);
    expect((await send(staffCookie, { ...body, submissionId: 'not-a-uuid' })).status).toBe(400);
  });

  it('keeps only the path of a page', () => {
    expect(feedbackPagePath(undefined)).toBeNull();
    expect(feedbackPagePath('/sample-storage')).toBe('/sample-storage');
    expect(feedbackPagePath('/sample-storage?search=DEMO-2601#top')).toBe('/sample-storage');
    expect(feedbackPagePath('/inventory#unit')).toBe('/inventory');
  });
});
