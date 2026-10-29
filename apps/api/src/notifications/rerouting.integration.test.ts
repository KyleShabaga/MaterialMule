import {
  actionRequestListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  notificationPreferencesSchema,
  projectDetailSchema,
  type ActionRequest,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-AO07 (D10, Kyle 2026-10-29): open action items follow current eligibility. An assignment to
// someone who lost the role, was disabled, or stopped being the project's Lead Project Engineer
// lapses back to ordinary routing (audited once, history kept), the people it now goes to are
// emailed (outbox only; nothing is sent), and items nobody can act on form the unresolved queue
// for Lab Managers and admins. Routing grants nothing. Real PostgreSQL; fictional data only:
// DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example (`pe`).
describe.runIf(testDatabaseUrl)('action item rerouting and the unresolved queue (MM-AO07)', () => {
  let h: LabHarness;
  let moisture: string;
  type As = Parameters<LabHarness['send']>[3];
  const cookies = new Map<string, string>();

  async function person(name: string, initials: string, roles: string[] = []) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status, work_email)
       VALUES ($1, $2, 'personal', 'active', $3) RETURNING id`,
      [name, initials, `${initials.toLowerCase()}-${newKey().slice(0, 6)}@example.test`],
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

  async function cancelRequest(testId: string): Promise<string> {
    const made = await h.send(
      'post',
      `/api/test-requests/${testId}/cancel-request`,
      { reason: 'Client withdrew this test', idempotencyKey: newKey() },
      'tech',
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.actionItemId as string;
  }

  async function closeRequest(programId: string): Promise<string> {
    const made = await h.send(
      'post',
      `/api/lab-programs/${programId}/close-request`,
      { reason: 'All tests are done', idempotencyKey: newKey() },
      'tech',
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.actionItemId as string;
  }

  async function inbox(who: As, query = 'status=open'): Promise<ActionRequest[]> {
    const response = await h.get(`/api/action-items?${query}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return actionRequestListSchema.parse(response.body).items;
  }
  const has = async (who: As, id: string, query?: string) =>
    (await inbox(who, query)).some((item) => item.id === id);
  const find = async (who: As, id: string, query = 'status=open&scope=all') =>
    (await inbox(who, query)).find((item) => item.id === id)!;

  const reassign = (id: string, to: string, reason = 'Covering this week') =>
    h.send(
      'post',
      `/api/action-items/${id}/reassign`,
      { toUserId: to, reason, idempotencyKey: newKey() },
      'admin',
    );

  async function emailOn(who: As) {
    const current = notificationPreferencesSchema.parse(
      (await h.get('/api/me/notification-preferences', who)).body,
    );
    const saved = await h
      .http()
      .put('/api/me/notification-preferences')
      .set('Cookie', who.startsWith(SESSION_COOKIE) ? who : await h.cookie(who as 'pe'))
      .set(CSRF_HEADER, '1')
      .send({ emailActionRequests: true, version: current.version });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }

  const outboxFor = async (itemId: string) =>
    (
      await h.db.pool.query<{ recipient_user_id: string }>(
        'SELECT recipient_user_id FROM email_outbox WHERE action_item_id = $1',
        [itemId],
      )
    ).rows.map((row) => row.recipient_user_id);
  const lapses = async (itemId: string) =>
    (
      await h.db.pool.query<{ reason: string }>(
        `SELECT reason FROM audit_event
         WHERE action = 'action_item.assignment_lapsed' AND entity_id = $1`,
        [itemId],
      )
    ).rows;

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

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('MC-AO7', 'Moisture content (fictional)', 'Moisture')).id;
    await h.db.pool.query(
      `UPDATE app_user SET work_email = lower(replace(display_name, ' ', '.')) || '@example.test'
       WHERE id = ANY($1::uuid[])`,
      [[h.users.pe, h.users.lm]],
    );
    await emailOn('lm');
    await emailOn('pe');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC2: losing the role lapses an assignment back to ordinary routing, audited once, and the new recipients are emailed', async () => {
    const lou = await person('Lou Second', 'LS', ['lab_manager']);
    const { testId } = await program();
    const id = await cancelRequest(testId);
    expect((await reassign(id, lou)).status).toBe(200);
    expect(await has(as(lou), id)).toBe(true);
    expect(await has('lm', id)).toBe(false);
    expect(await has('pe', id)).toBe(false);
    const emailedBefore = await outboxFor(id);

    const roles = await h
      .http()
      .put(`/api/staff/${lou}/roles`)
      .set('Cookie', await h.cookie('admin'))
      .set(CSRF_HEADER, '1')
      .send({ roles: [], reason: 'Moved to field work' });
    expect(roles.status, JSON.stringify(roles.body)).toBe(200);

    // Back with the Lead Project Engineer and Lab Managers; no longer Lou's.
    expect(await has(as(lou), id)).toBe(false);
    expect(await has('lm', id)).toBe(true);
    expect(await has('pe', id)).toBe(true);
    const item = await find('admin', id);
    expect(item).toMatchObject({
      assignmentLapsed: true,
      unresolved: false,
      assignedTo: { name: 'Lou Second' },
      routedTo: 'Lead Project Engineer and Lab Managers (Lou Second can no longer act on it)',
    });
    expect(await lapses(id)).toEqual([{ reason: 'Roles changed: Moved to field work' }]);
    // The people it now goes to (opted in) are told; nobody twice.
    const emailed = await outboxFor(id);
    expect(emailed).toEqual(expect.arrayContaining([h.users.lm, h.users.pe]));
    expect(new Set(emailed).size).toBe(emailed.length);
    expect(emailed.length).toBeGreaterThanOrEqual(emailedBefore.length);
    // History is kept: the assignment row is unchanged.
    const { rows: assignments } = await h.db.pool.query(
      'SELECT to_user_id FROM action_item_assignment WHERE action_item_id = $1',
      [id],
    );
    expect(assignments).toEqual([{ to_user_id: lou }]);

    // Disabled afterwards: no second lapse for the same assignment.
    const disabled = await h.send(
      'post',
      `/api/staff/${lou}/disable`,
      { reason: 'Left the firm' },
      'admin',
    );
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(await lapses(id)).toHaveLength(1);

    // A Lab Manager or admin can give it to an eligible person again, with a reason.
    expect((await reassign(id, h.users.lm, 'Lee takes it')).status).toBe(200);
    expect(await find('admin', id)).toMatchObject({
      assignmentLapsed: false,
      assignedTo: { name: 'Lee Manager' },
    });
  });

  it('AC2: disabling the assignee lapses their assignment', async () => {
    const dana = await person('Dana Covering', 'DC', ['lab_manager']);
    const { testId } = await program();
    const id = await cancelRequest(testId);
    expect((await reassign(id, dana)).status).toBe(200);
    const disabled = await h.send(
      'post',
      `/api/staff/${dana}/disable`,
      { reason: 'Extended leave' },
      'admin',
    );
    expect(disabled.status).toBe(200);
    expect(await has('lm', id)).toBe(true);
    expect(await lapses(id)).toEqual([{ reason: 'Account disabled: Extended leave' }]);
    expect((await find('admin', id)).assignmentLapsed).toBe(true);
  });

  it('AC2: a lead change sends lead requests to the new lead, lapses an assignment to the old lead, and tells the new lead', async () => {
    const sam = await person('Sam Newlead', 'SN');
    await emailOn(as(sam));
    const closing = await program('b');
    const closure = await closeRequest(closing.program.id);
    const { testId } = await program('b');
    const cancellation = await cancelRequest(testId);
    expect((await reassign(cancellation, h.users.pe, 'Pat decides this one')).status).toBe(200);
    expect(await has('pe', closure)).toBe(true);

    await setLead('b', sam, 'Pat moved to another office');

    expect(await has(as(sam), closure)).toBe(true);
    expect(await has('pe', closure)).toBe(false);
    // Pat is no longer the lead and isn't a Lab Manager: the assignment lapsed.
    expect(await has('pe', cancellation)).toBe(false);
    expect(await has(as(sam), cancellation)).toBe(true);
    expect(await has('lm', cancellation)).toBe(true);
    expect(await lapses(cancellation)).toEqual([
      { reason: 'Lead Project Engineer changed: Pat moved to another office' },
    ]);
    expect(await outboxFor(closure)).toContain(sam);
    expect(await outboxFor(cancellation)).toContain(sam);

    // Routing grants nothing: Pat can no longer close, whatever the inbox said earlier.
    const refused = await h.send(
      'post',
      `/api/lab-programs/${closing.program.id}/close`,
      { version: closing.program.version, idempotencyKey: newKey() },
      'pe',
    );
    expect(refused.status).toBe(403);

    await setLead('b', h.users.pe, 'Pat returns');
  });

  it('D10/D02: a request nobody can act on joins the unresolved queue for Lab Managers and admins', async () => {
    const { program: p } = await program('b');
    const closure = await closeRequest(p.id);
    await setLead('b', null, 'Lead left; waiting for a new one');

    for (const who of ['lm', 'admin'] as const) {
      const queue = await inbox(who, 'status=open&scope=unresolved');
      expect(queue.find((item) => item.id === closure)).toMatchObject({
        unresolved: true,
        routedTo: 'Waiting for a Lead Project Engineer',
      });
      expect(queue.every((item) => item.unresolved)).toBe(true);
    }
    expect((await h.get('/api/action-items?status=open&scope=unresolved', 'tech')).status).toBe(
      403,
    );
    expect((await h.get('/api/action-items?status=open&scope=nope', 'lm')).status).toBe(400);
    expect(await has('pe', closure)).toBe(false);
    // Nobody is eligible to take a lead-only request until a lead is appointed.
    const people = await h.get(`/api/action-items/${closure}/assignees`, 'admin');
    expect(people.body.people).toEqual([]);

    await setLead('b', h.users.pe, 'Pat appointed again');
    expect(await has('pe', closure)).toBe(true);
    expect(
      (await inbox('lm', 'status=open&scope=unresolved')).some((item) => item.id === closure),
    ).toBe(false);
  });

  it('AC4: a refused decision changes nothing and sends nothing', async () => {
    const { program: p } = await program();
    const counts = async () =>
      (
        await h.db.pool.query(
          `SELECT (SELECT count(*)::int FROM action_item) AS items,
                  (SELECT count(*)::int FROM email_outbox) AS outbox,
                  (SELECT count(*)::int FROM audit_event) AS audit,
                  (SELECT status FROM lab_program WHERE id = $1) AS status`,
          [p.id],
        )
      ).rows[0];
    const before = await counts();
    for (const who of ['tech', 'lm', 'admin'] as const) {
      const refused = await h.send(
        'post',
        `/api/lab-programs/${p.id}/close`,
        { version: p.version, idempotencyKey: newKey() },
        who,
      );
      expect(refused.status, who).toBe(403);
    }
    expect(await counts()).toEqual(before);
  });
});
