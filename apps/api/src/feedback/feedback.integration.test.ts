import type { INestApplication } from '@nestjs/common';
import { feedbackListSchema, submitFeedbackResponseSchema } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
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

  async function userWithSession(
    name: string,
    initials: string,
    status: 'active' | 'pending',
    role?: string,
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
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
  });

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
});
