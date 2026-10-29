import { randomUUID } from 'node:crypto';
import {
  actionRequestListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  notificationPreferencesSchema,
  type LabProgram,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { EmailWorker, sanitizeEmailError, type EmailMessage } from './email-worker.js';

// MM-T27 Action requests (card AC1–AC8, test plan T1–T4, T6, T7). Real PostgreSQL; no email is
// ever sent: the outbox is asserted directly and the worker runs against an in-memory transport.
// Fictional data only: DEMO-2601 (A) with Lead Project Engineer Pat Example (`pe`); Lee Manager (`lm`) Lab
// Manager; Alex Tester (`tech`) Technician; Admin Example (`admin`) admin only.
describe.runIf(testDatabaseUrl)('action requests (MM-T27)', () => {
  let h: LabHarness;
  let moisture: string;
  let lm2: string;
  type As = Parameters<LabHarness['send']>[3];

  async function submit(lines: unknown[]): Promise<LabProgram> {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines },
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

  async function program() {
    const holeId = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects.a, `TH-${newKey().slice(0, 8)}`],
      )
    ).rows[0]!.id;
    const bucket = await h.bucket({ hole: holeId });
    const p = await submit([line({ kind: 'test_hole', id: holeId }, 'all', [moisture])]);
    return { program: p, bucket, testId: p.lines[0]!.requests[0]!.id };
  }

  const status = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('post', `/api/test-requests/${id}/status`, { idempotencyKey: newKey(), ...body }, as);
  const version = async (id: string) =>
    (
      await h.db.pool.query<{ version: number }>('SELECT version FROM test_request WHERE id = $1', [
        id,
      ])
    ).rows[0]!.version;

  async function inReview(testId: string) {
    for (const to of ['in_progress', 'completed', 'review']) {
      const moved = await status(testId, { to, version: await version(testId) });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    }
  }

  async function returned(testId: string) {
    await inReview(testId);
    const back = await h.send(
      'post',
      `/api/test-requests/${testId}/review`,
      {
        idempotencyKey: newKey(),
        action: 'return',
        comment: 'Recheck moisture',
        version: await version(testId),
      },
      'tech',
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  }

  const closeRequest = (programId: string, as: As = 'tech', key = newKey()) =>
    h.send(
      'post',
      `/api/lab-programs/${programId}/close-request`,
      { reason: 'All tests are done', idempotencyKey: key },
      as,
    );
  const cancelRequest = (testId: string, as: As = 'tech', key = newKey()) =>
    h.send(
      'post',
      `/api/test-requests/${testId}/cancel-request`,
      { reason: 'Client withdrew this test', idempotencyKey: key },
      as,
    );

  async function inbox(as: As, query = 'status=open') {
    const response = await h.get(`/api/action-items?${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return actionRequestListSchema.parse(response.body).items;
  }
  const openCount = async (as: As) => (await h.get('/api/action-items/count', as)).body.open;

  async function setEmail(as: As, on: boolean) {
    const current = notificationPreferencesSchema.parse(
      (await h.get('/api/me/notification-preferences', as)).body,
    );
    const saved = await h
      .http()
      .put('/api/me/notification-preferences')
      .set('Cookie', as.startsWith(SESSION_COOKIE) ? as : await h.cookie(as as 'pe'))
      .set('x-materialmule-csrf', '1')
      .send({ emailActionRequests: on, version: current.version });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  async function outbox(itemId: string) {
    const { rows } = await h.db.pool.query<{
      recipient_user_id: string;
      to_address: string;
      status: string;
      attempts: number;
      last_error: string | null;
      subject: string;
      body: string;
    }>(
      `SELECT recipient_user_id, to_address, status, attempts, last_error, subject, body
       FROM email_outbox WHERE action_item_id = $1 ORDER BY recipient_user_id`,
      [itemId],
    );
    return rows;
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await h.db.pool.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n;

  beforeAll(async () => {
    h = await createLabHarness();
    const created = await h.testType('MC', 'Moisture content', 'Moisture');
    moisture = created.id;
    // A second Lab Manager, so role-shared items have two recipients.
    lm2 = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status, work_email)
         VALUES ('Lou Second', 'LS', 'personal', 'active', 'lou.second@example.test') RETURNING id`,
      )
    ).rows[0]!.id;
    await h.db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
      [lm2],
    );
    await h.db.pool.query(
      `UPDATE app_user SET work_email = lower(replace(display_name, ' ', '.')) || '@example.test'
       WHERE id = ANY($1::uuid[])`,
      [[h.users.pe, h.users.lm, h.users.tech, h.users.admin]],
    );
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  const lm2Cookie = async () => {
    const session = await h.app.get(SessionService).create(lm2, 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  };

  it('T1/AC1: a closure request goes to the Lead Project Engineer only, not the requester or Lab Managers', async () => {
    const { program: p } = await program();
    const created = await closeRequest(p.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const peItems = await inbox('pe');
    const item = peItems.find((i) => i.id === created.body.actionItemId);
    expect(item).toMatchObject({
      kind: 'closure_request',
      status: 'open',
      title: `Closure requested for ${p.programNumber}`,
      routeTag: 'Lead Project Engineer',
      reason: 'All tests are done',
      requestedBy: { initials: 'AT', name: 'Alex Tester' },
      href: `/lab-testing/programs/${p.id}`,
      projectNumber: 'DEMO-2601',
    });
    for (const who of ['tech', 'lm', 'admin'] as const) {
      expect(
        (await inbox(who)).some((i) => i.id === created.body.actionItemId),
        who,
      ).toBe(false);
    }
    expect(await openCount('pe')).toBeGreaterThanOrEqual(1);
  });

  it('T1: a cancellation request goes to the Lead Project Engineer and every Lab Manager', async () => {
    const { testId } = await program();
    const created = await cancelRequest(testId);
    expect(created.status).toBe(201);
    for (const who of ['pe', 'lm'] as const) {
      const item = (await inbox(who)).find((i) => i.id === created.body.actionItemId);
      expect(item, who).toMatchObject({
        kind: 'cancellation_request',
        routeTag: 'LM · Lead Project Engineer',
      });
    }
    expect((await inbox(await lm2Cookie())).some((i) => i.id === created.body.actionItemId)).toBe(
      true,
    );
    expect((await inbox('tech')).some((i) => i.id === created.body.actionItemId)).toBe(false);
  });

  it('T2/AC2: a correction is shared by every Lab Manager and the first to act resolves it for all', async () => {
    const { testId } = await program();
    await returned(testId);
    const [item] = (await inbox('lm')).filter(
      (i) => i.kind === 'correction' && i.href.includes('/lab-testing/'),
    );
    const mine = (await inbox(await lm2Cookie())).find((i) => i.id === item!.id);
    expect(mine).toMatchObject({ routeTag: 'LM', status: 'open' });
    expect((await inbox('pe')).some((i) => i.id === item!.id)).toBe(false);

    const done = await h.send(
      'post',
      `/api/test-requests/${testId}/correction-done`,
      { idempotencyKey: newKey(), note: 'Fixed the entry', version: await version(testId) },
      'lm',
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    for (const who of ['lm', await lm2Cookie()]) {
      expect((await inbox(who)).some((i) => i.id === item!.id)).toBe(false);
      const resolved = (await inbox(who, 'status=resolved')).find((i) => i.id === item!.id);
      expect(resolved).toMatchObject({
        status: 'resolved',
        resolvedBy: { name: 'Lee Manager', initials: 'LM' },
      });
    }
  });

  it('AC6: the inbox resolves nothing; a Technician who cannot close leaves the item open', async () => {
    const { program: p } = await program();
    const { body } = await closeRequest(p.id);
    // No inbox route changes status: there is no resolve/approve endpoint at all.
    for (const path of ['resolve', 'approve', 'close']) {
      const attempt = await h.send(
        'post',
        `/api/action-items/${body.actionItemId}/${path}`,
        {},
        'tech',
      );
      expect(attempt.status, path).toBe(404);
    }
    const close = await h.send(
      'post',
      `/api/lab-programs/${p.id}/close`,
      { version: p.version, idempotencyKey: newKey() },
      'tech',
    );
    expect(close.status).toBe(403);
    expect(
      await count(`FROM action_item WHERE id = $1 AND status = 'open'`, [body.actionItemId]),
    ).toBe(1);
  });

  it('T4/AC3: progress, comments and moves create no action item or email', async () => {
    await setEmail('lm', true);
    await setEmail('pe', true);
    const { program: p, testId, bucket } = await program();
    const itemsBefore = await count('FROM action_item');
    const outboxBefore = await count('FROM email_outbox');
    const [stationA, stationB] = [await h.cookie('lab'), await h.cookie('lab')];
    expect(
      (
        await status(
          testId,
          { to: 'in_progress', version: 1, actingStaffUserId: h.users.lm },
          stationA,
        )
      ).status,
    ).toBe(200);
    const comment = await h.send(
      'post',
      `/api/lab-programs/${p.id}/comments`,
      { body: 'Started drying', idempotencyKey: newKey(), actingStaffUserId: h.users.pe },
      stationB,
    );
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const shelf = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO location (code, name, kind) VALUES ('T27-SHELF', 'T27 shelf', 'warehouse')
         RETURNING id`,
      )
    ).rows[0]!.id;
    const move = await h.send(
      'post',
      '/api/moves',
      {
        clientMoveId: randomUUID(),
        storageUnitId: bucket.id,
        toLocationId: shelf,
        baseVersion: 1,
        scannedAt: new Date().toISOString(),
        capturedOffline: false,
        captureContext: { stationId: randomUUID(), accountId: h.users.tech },
      },
      'tech',
    );
    expect(move.status, JSON.stringify(move.body)).toBeLessThan(300);
    expect(await count('FROM action_item')).toBe(itemsBefore);
    expect(await count('FROM email_outbox')).toBe(outboxBefore);
  });

  it('T3/AC4: email preference on → exactly one outbox row per recipient, even when creation is retried', async () => {
    await setEmail('pe', true);
    await setEmail('lm', true);
    await setEmail('tech', true);
    const { program: p, testId } = await program();
    const key = newKey();
    const [first, second] = await Promise.all([
      closeRequest(p.id, 'tech', key),
      closeRequest(p.id, 'tech', key),
    ]);
    const ids = [first, second].filter((r) => r.status === 201).map((r) => r.body.actionItemId);
    expect(new Set(ids).size).toBe(1);
    const retried = await closeRequest(p.id, 'tech', key);
    expect(retried.body.actionItemId).toBe(ids[0]);
    const rows = await outbox(ids[0]);
    expect(rows.map((r) => [r.recipient_user_id, r.to_address, r.status])).toEqual([
      [h.users.pe, 'pat.example@example.test', 'pending'],
    ]);
    expect(rows[0]!.subject).toBe(`Material Mule: Closure requested for ${p.programNumber}`);

    // A role-shared item: one row each for the Lead Project Engineer and the opted-in Lab Manager; Lou (off) none.
    const cancelled = await cancelRequest(testId);
    const recipients = (await outbox(cancelled.body.actionItemId)).map((r) => r.recipient_user_id);
    expect(recipients.sort()).toEqual([h.users.pe, h.users.lm].sort());
  });

  it('AC4: email preference off (the default) → no outbox row', async () => {
    const prefs = notificationPreferencesSchema.parse(
      (await h.get('/api/me/notification-preferences', 'admin')).body,
    );
    expect(prefs).toEqual({
      emailActionRequests: false,
      emailSendingEnabled: false,
      hasWorkEmail: true,
      version: 0,
    });
    await setEmail('pe', false);
    const { program: p } = await program();
    const { body } = await closeRequest(p.id);
    expect(await outbox(body.actionItemId)).toEqual([]);
    await setEmail('pe', true);
  });

  it('T3/AC5: the worker retries with backoff, never stores the address in errors, and skips resolved items', async () => {
    await setEmail('pe', true);
    const { program: p } = await program();
    const { body } = await closeRequest(p.id);
    const sent: EmailMessage[] = [];
    let fail = 2;
    let clock = new Date('2030-01-01T00:00:00Z');
    const worker = new EmailWorker(
      h.db.pool,
      {
        send(message) {
          if (fail > 0) {
            fail -= 1;
            return Promise.reject(new Error(`SMTP refused ${message.to}`));
          }
          sent.push(message);
          return Promise.resolve();
        },
      },
      { baseDelayMs: 1000, now: () => clock },
    );
    // Only this item's row is due in the far future clock; earlier rows from other tests are too,
    // so isolate by marking those skipped first.
    await h.db.pool.query(
      `UPDATE email_outbox SET status = 'skipped' WHERE status = 'pending' AND action_item_id <> $1`,
      [body.actionItemId],
    );
    expect(await worker.runOnce()).toMatchObject({ retried: 1, sent: 0 });
    let [row] = await outbox(body.actionItemId);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row!.last_error).toBe('Error: SMTP refused <address>');
    // Not due yet: nothing happens until the backoff passes.
    expect(await worker.runOnce()).toMatchObject({ retried: 0, sent: 0 });
    clock = new Date(clock.getTime() + 1000);
    expect(await worker.runOnce()).toMatchObject({ retried: 1 });
    clock = new Date(clock.getTime() + 2000);
    expect(await worker.runOnce()).toMatchObject({ sent: 1 });
    [row] = await outbox(body.actionItemId);
    expect(row).toMatchObject({ status: 'sent', attempts: 3, last_error: null });
    expect(sent).toHaveLength(1);
    expect(await worker.runOnce()).toMatchObject({ sent: 0 });

    // An item resolved before its email goes out is skipped, not sent.
    const second = await program();
    const request = await closeRequest(second.program.id);
    await h.db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2,
              resolution = 'closed' WHERE id = $1`,
      [request.body.actionItemId, h.users.pe],
    );
    expect(await worker.runOnce()).toMatchObject({ skipped: 1, sent: 0 });
    expect(sanitizeEmailError('x')).toBe('Send failed');
  });

  it('AC5: EMAIL_ENABLED is refused, so nothing can be sent in development or tests', () => {
    const base = {
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://x@localhost/x',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    };
    expect(loadConfig(base).EMAIL_ENABLED).toBe(false);
    expect(() => loadConfig({ ...base, EMAIL_ENABLED: 'true' })).toThrow(/EMAIL_ENABLED/);
    expect(() => loadConfig({ ...base, EMAIL_ENABLED: 'true', APP_ENV: 'development' })).toThrow(
      /EMAIL_ENABLED/,
    );
  });

  it('T6/AC7: LAB stations, whoever they select, have no inbox, preferences or reassignment', async () => {
    const { program: p } = await program();
    const { body } = await closeRequest(p.id);
    const [stationA, stationB] = [await h.cookie('lab'), await h.cookie('lab')];
    for (const station of [stationA, stationB]) {
      expect((await h.get('/api/action-items', station)).status).toBe(403);
      expect((await h.get('/api/action-items/count', station)).status).toBe(403);
      expect((await h.get('/api/me/notification-preferences', station)).status).toBe(403);
      const put = await h
        .http()
        .put('/api/me/notification-preferences')
        .set('Cookie', station)
        .set('x-materialmule-csrf', '1')
        .send({ emailActionRequests: true, version: 0 });
      expect(put.status).toBe(403);
      const reassign = await h.send(
        'post',
        `/api/action-items/${body.actionItemId}/reassign`,
        {
          toUserId: h.users.pe,
          reason: 'x',
          idempotencyKey: newKey(),
          actingStaffUserId: h.users.lm,
        },
        station,
      );
      expect(reassign.status).toBe(403);
      // Selecting the Lead Project Engineer for lab work never lets LAB close or decide.
      const close = await h.send(
        'post',
        `/api/lab-programs/${p.id}/close`,
        { version: p.version, idempotencyKey: newKey(), actingStaffUserId: h.users.pe },
        station,
      );
      expect(close.status).toBe(403);
    }
    expect(await count(`FROM notification_preference WHERE user_id = $1`, [h.users.lab])).toBe(0);
  });

  it('reassignment: Lab Manager/admin only, to an eligible person, with a reason, audited; recipients cannot pass items on', async () => {
    const { testId } = await program();
    const { body } = await cancelRequest(testId);
    const id = body.actionItemId as string;
    const reassign = (to: string, as: As, key = newKey(), reason = 'Pat is on leave') =>
      h.send(
        'post',
        `/api/action-items/${id}/reassign`,
        { toUserId: to, reason, idempotencyKey: key },
        as,
      );

    // The Lead Project Engineer recipient (no Lab Manager/admin role) can't pass it on.
    expect((await reassign(h.users.lm, 'pe')).status).toBe(403);
    expect((await reassign(h.users.lm, 'tech')).status).toBe(403);
    // Not eligible: a Technician can't cancel tests.
    const wrong = await reassign(h.users.tech, 'admin');
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('assignee_not_eligible');
    const people = await h.get(`/api/action-items/${id}/assignees`, 'admin');
    expect(people.body.people.map((p: { name: string }) => p.name)).toEqual([
      'Lee Manager',
      'Lou Second',
      'Pat Example',
    ]);

    const key = newKey();
    const moved = await reassign(lm2, 'admin', key);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ routeTag: 'LS', assignedTo: { name: 'Lou Second' } });
    expect((await reassign(lm2, 'admin', key)).status).toBe(200); // exact retry
    expect((await reassign(h.users.pe, 'admin', key)).status).toBe(409); // key reused
    expect(await count('FROM action_item_assignment WHERE action_item_id = $1', [id])).toBe(1);
    expect(
      await count(`FROM audit_event WHERE action = 'action_item.reassigned' AND entity_id = $1`, [
        id,
      ]),
    ).toBe(1);
    // Now only Lou sees it; the others no longer do.
    expect((await inbox(await lm2Cookie())).some((i) => i.id === id)).toBe(true);
    expect((await inbox('lm')).some((i) => i.id === id)).toBe(false);
    expect((await inbox('pe')).some((i) => i.id === id)).toBe(false);
    // Lou, its assignee, can't pass it on even though Lou is a Lab Manager.
    const lou = await lm2Cookie();
    const passOn = await h.send(
      'post',
      `/api/action-items/${id}/reassign`,
      { toUserId: h.users.lm, reason: 'Not me', idempotencyKey: newKey() },
      lou,
    );
    expect(passOn.status).toBe(403);
    expect(passOn.body.code).toBe('recipient_cannot_reassign');
    // A Lab Manager who isn't its assignee may.
    expect((await reassign(h.users.pe, 'lm')).status).toBe(200);

    // The Lead Project Engineer resolves it through the real cancellation.
    const cancel = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel`,
      { reason: 'Client withdrew', version: await version(testId), idempotencyKey: newKey() },
      'pe',
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await reassign(h.users.lm, 'admin')).status).toBe(409); // resolved
  });

  it('MM-T71 T2/AC2: two concurrent same-key reassigns both get 200 with one assignment and one audit', async () => {
    const { testId } = await program();
    const { body } = await cancelRequest(testId);
    const id = body.actionItemId as string;
    const key = newKey();
    const send = () =>
      h.send(
        'post',
        `/api/action-items/${id}/reassign`,
        { toUserId: lm2, reason: 'Lou covers this week', idempotencyKey: key },
        'admin',
      );
    // Barrier: hold the item row so both requests pass the first key check and queue on the lock.
    const blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM action_item WHERE id = $1 FOR UPDATE', [id]);
      const both = Promise.all([send(), send()]);
      await waitForLockWaiters(2);
      await blocker.query('COMMIT');
      const results = await both;
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results[1]!.body).toEqual(results[0]!.body);
      expect(results[0]!.body).toMatchObject({ assignedTo: { name: 'Lou Second' } });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }
    expect(await count('FROM action_item_assignment WHERE action_item_id = $1', [id])).toBe(1);
    expect(
      await count(`FROM audit_event WHERE action = 'action_item.reassigned' AND entity_id = $1`, [
        id,
      ]),
    ).toBe(1);
  });

  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 2000; i += 1) {
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%action_item%FOR UPDATE%'`,
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`fewer than ${n} requests waited on action_item`);
  }

  it('an item reassigned away from an opted-in recipient is skipped for them, not sent', async () => {
    await setEmail('pe', true);
    await setEmail('lm', true);
    const { testId } = await program();
    const { body } = await cancelRequest(testId);
    await h.db.pool.query(
      `UPDATE email_outbox SET status = 'skipped' WHERE status = 'pending' AND action_item_id <> $1`,
      [body.actionItemId],
    );
    const moved = await h.send(
      'post',
      `/api/action-items/${body.actionItemId}/reassign`,
      { toUserId: h.users.lm, reason: 'LM covers it', idempotencyKey: newKey() },
      'admin',
    );
    expect(moved.status).toBe(200);
    const sent: EmailMessage[] = [];
    const worker = new EmailWorker(h.db.pool, {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    });
    expect(await worker.runOnce()).toMatchObject({ sent: 1, skipped: 1 });
    expect(sent.map((m) => m.to)).toEqual(['lee.manager@example.test']);
  });

  it('T7/AC8: concurrent closes by two personal sessions resolve the item once', async () => {
    await setEmail('pe', true);
    const { program: p, testId } = await program();
    const { body } = await closeRequest(p.id);
    const cancel = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel`,
      { reason: 'Not needed', version: await version(testId), idempotencyKey: newKey() },
      'pe',
    );
    expect(cancel.status).toBe(200);
    const current = (
      await h.db.pool.query<{ version: number }>('SELECT version FROM lab_program WHERE id = $1', [
        p.id,
      ])
    ).rows[0]!.version;
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
    // One close commits; the other, behind its row lock, finds the program already closed.
    const codes = results.map((r) => r.status).sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(422);
    expect(
      await count(
        `FROM action_item WHERE id = $1 AND status = 'resolved' AND resolution = 'closed'`,
        [body.actionItemId],
      ),
    ).toBe(1);
    expect(
      await count(`FROM audit_event WHERE action = 'lab_program.closed' AND entity_id = $1`, [
        p.id,
      ]),
    ).toBe(1);
    expect((await outbox(body.actionItemId)).length).toBe(1);
    const resolved = (await inbox('pe', 'status=resolved')).find((i) => i.id === body.actionItemId);
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'closed' });
  });

  it('database rules: one resolution, assignment only while open, one outbox row per recipient', async () => {
    const { program: p } = await program();
    const { body } = await closeRequest(p.id);
    const id = body.actionItemId as string;
    const fails = async (sql: string, params: unknown[]) => {
      try {
        await h.db.pool.query(sql, params);
        return null;
      } catch (error) {
        return (
          (error as { code?: string; constraint?: string }).constraint ??
          (error as { code?: string }).code
        );
      }
    };
    // The project follows the program and can't disagree with it.
    expect(
      await count(
        'FROM action_item a JOIN lab_program lp ON lp.id = a.program_id WHERE a.id = $1 AND a.project_id = lp.project_id',
        [id],
      ),
    ).toBe(1);
    expect(
      await fails('UPDATE action_item SET project_id = $2 WHERE id = $1', [id, h.projects.b]),
    ).toBe('23001');
    expect(await fails('DELETE FROM action_item WHERE id = $1', [id])).toBe('23001');
    // Assignment: set while open, never cleared; nothing changes once resolved.
    await h.db.pool.query(
      'UPDATE action_item SET assigned_user_id = $2, assigned_at = now() WHERE id = $1',
      [id, h.users.pe],
    );
    expect(
      await fails(
        'UPDATE action_item SET assigned_user_id = NULL, assigned_at = NULL WHERE id = $1',
        [id],
      ),
    ).toBe('23001');
    await h.db.pool.query(
      `UPDATE action_item SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2,
              resolution = 'closed' WHERE id = $1`,
      [id, h.users.pe],
    );
    expect(
      await fails(
        'UPDATE action_item SET assigned_user_id = $2, assigned_at = now() WHERE id = $1',
        [id, h.users.lm],
      ),
    ).toBe('23001');
    expect(
      await fails(`UPDATE action_item SET resolved_by_user_id = $2 WHERE id = $1`, [
        id,
        h.users.lm,
      ]),
    ).toBe('23001');
    // One outbox row per (item, recipient), whatever writes it.
    const insert = `INSERT INTO email_outbox (action_item_id, recipient_user_id, to_address, subject, body)
                    VALUES ($1, $2, 'x@example.test', 's', 'b')`;
    await h.db.pool.query(insert, [id, h.users.admin]);
    expect(await fails(insert, [id, h.users.admin])).toBe('email_outbox_one_per_recipient');
    expect(
      await fails(
        `UPDATE email_outbox SET status = 'sent' WHERE action_item_id = $1 AND recipient_user_id = $2`,
        [id, h.users.admin],
      ),
    ).toBe('email_outbox_sent_shape');
  });

  it('preferences: personal only, stale version gets 409, change is audited', async () => {
    const prefs = notificationPreferencesSchema.parse(
      (await h.get('/api/me/notification-preferences', 'js')).body,
    );
    expect(prefs.emailActionRequests).toBe(false);
    const cookie = await h.cookie('js');
    const put = (on: boolean, v: number) =>
      h
        .http()
        .put('/api/me/notification-preferences')
        .set('Cookie', cookie)
        .set('x-materialmule-csrf', '1')
        .send({ emailActionRequests: on, version: v });
    expect((await put(true, 0)).body).toMatchObject({ emailActionRequests: true, version: 1 });
    expect((await put(false, 0)).status).toBe(409);
    expect((await put(false, 1)).body).toMatchObject({ emailActionRequests: false, version: 2 });
    expect(
      await count(
        `FROM audit_event WHERE action = 'notification_preference.changed' AND entity_id = $1`,
        [h.users.js],
      ),
    ).toBe(2);
  });
});
