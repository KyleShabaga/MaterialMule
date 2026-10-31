import {
  positionRulesSchema,
  projectCapabilitiesSchema,
  projectReviewersSchema,
  staffGrantsSchema,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MISC-08: position-based review eligibility, exclusions, accepted team membership and the
// lead's separate review approval. Real PostgreSQL through the API; the race uses a second
// connection and the real lock, never sleeps. Fictional data only: DEMO-2601 (A, lead Pat Example
// `pe`) and DEMO-2602 (B, led here by Jordan Smith `js`).
describe.runIf(testDatabaseUrl)('review eligibility and LPE review approval (MISC-08)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  const FIELD = 'concrete_field';
  const STRENGTH = 'concrete_strength';

  // async, so the request starts when called (supertest runs only once awaited or then-ed).
  const send = async (
    method: 'post' | 'delete' | 'patch',
    path: string,
    body: unknown,
    as: string,
  ) =>
    h
      .http()
      [method](path)
      .set(CSRF_HEADER, '1')
      .set('Cookie', cookies[as] ?? as)
      .send(body as object);
  const projectPath = (project: 'a' | 'b', rest: string) =>
    `/api/projects/${h.projects[project]}/${rest}`;

  /** A fresh fictional engineer with a session; returns their id and cookie. */
  async function person(name: string, position: string | null = null) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status, position,
                             position_set_at)
       VALUES ($1, 'RX', 'personal', 'active', $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [name, position],
    );
    const id = rows[0]!.id;
    const session = await h.app.get(SessionService).create(id, 'personal');
    cookies[id] = `${SESSION_COOKIE}=${session.token}`;
    return id;
  }

  const grant = async (userId: string, scopeCode = FIELD) =>
    staffGrantsSchema.parse(
      (
        await send(
          'post',
          `/api/staff/${userId}/reviewer-eligibility`,
          { scopeCode, reason: 'Certified', idempotencyKey: newKey() },
          'admin',
        )
      ).body,
    );
  const exclude = (userId: string, scopeCode: string | null) =>
    send(
      'post',
      `/api/staff/${userId}/reviewer-exclusions`,
      { scopeCode, reason: 'Under review', idempotencyKey: newKey() },
      'admin',
    );
  const enableRule = (position: string, scopeCode = FIELD, as = 'admin') =>
    send(
      'post',
      '/api/review-eligibility/position-rules',
      { position, scopeCode, reason: 'Engineers review field reports', idempotencyKey: newKey() },
      as,
    );
  const join = (project: 'a' | 'b', userId: string) =>
    send(
      'post',
      projectPath(project, 'team-members'),
      { userId, reason: 'On the project', idempotencyKey: newKey() },
      'admin',
    );
  async function assign(project: 'a' | 'b', userId: string, scopeCode = FIELD) {
    const response = await send(
      'post',
      projectPath(project, 'reviewer-assignments'),
      { reviewerUserId: userId, scopeCode, reason: 'Reviews this', idempotencyKey: newKey() },
      'admin',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return projectReviewersSchema
      .parse(response.body)
      .active.find((r) => r.reviewer.userId === userId && r.scope.code === scopeCode)!.id;
  }
  const approve = (project: 'a' | 'b', assignmentId: string, as = 'pe') =>
    send(
      'post',
      projectPath(project, `reviewer-assignments/${assignmentId}/approval`),
      { idempotencyKey: newKey() },
      as,
    );
  const scopesOf = async (project: 'a' | 'b', userId: string) =>
    projectCapabilitiesSchema
      .parse(
        (await h.http().get(projectPath(project, 'capabilities')).set('Cookie', cookies[userId]!))
          .body,
      )
      .reviewerScopes.map((s) => s.code);
  const effective = async (userId: string) =>
    staffGrantsSchema
      .parse((await h.http().get(`/api/staff/${userId}/grants`).set('Cookie', cookies.admin!)).body)
      .effectiveEligibility.map((e) => [e.scope.code, e.eligible]);
  const approvals = async (userId: string) =>
    (
      await h.db.pool.query<{ ended: boolean; end_kind: string | null }>(
        `SELECT ended_at IS NOT NULL AS ended, end_kind FROM project_review_approval
         WHERE reviewer_user_id = $1 ORDER BY approved_at, id`,
        [userId],
      )
    ).rows;

  /** Eligible (individual grant), accepted member, assigned and approved on A, in FIELD. */
  async function reviewer(name: string, position: string | null = null) {
    const id = await person(name, position);
    await grant(id);
    expect((await join('a', id)).status).toBe(201);
    const assignment = await assign('a', id);
    const approved = await approve('a', assignment);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    return { id, assignment };
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['admin', 'pe', 'js', 'tech', 'lm'] as const)
      cookies[key] = await h.cookie(key);
    await h.db.pool.query('UPDATE project SET lead_project_engineer_user_id = $1 WHERE id = $2', [
      h.users.js,
      h.projects.b,
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('only admins manage rules, grants and exclusions, through the API too', async () => {
    const someone = await person('Una Unmanaged', 'engineer');
    for (const as of ['pe', 'tech', 'lm']) {
      expect((await enableRule('engineer', FIELD, as)).status).toBe(403);
      expect(
        (
          await send(
            'post',
            `/api/staff/${someone}/reviewer-exclusions`,
            { scopeCode: null, reason: 'Not theirs to do', idempotencyKey: newKey() },
            as,
          )
        ).status,
      ).toBe(403);
      expect(
        (await h.http().get('/api/review-eligibility/position-rules').set('Cookie', cookies[as]!))
          .status,
      ).toBe(403);
    }
    // Reasons are required for eligibility changes and exclusions.
    const noReason = await send(
      'post',
      `/api/staff/${someone}/reviewer-exclusions`,
      { scopeCode: null, idempotencyKey: newKey() },
      'admin',
    );
    expect(noReason.status).toBe(400);
  });

  it('no position is eligible by default; a rule covers current and later holders', async () => {
    const eng = await person('Eve Engineer', 'engineer');
    const tech = await person('Theo Technologist', 'technologist');
    const unset = await person('Nell Notset', null);
    expect(await effective(eng)).toEqual([
      [FIELD, false],
      [STRENGTH, false],
    ]);
    const rule = await enableRule('engineer');
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(await effective(eng)).toEqual([
      [FIELD, true],
      [STRENGTH, false],
    ]);
    expect((await effective(tech))[0]).toEqual([FIELD, false]);
    expect((await effective(unset))[0]).toEqual([FIELD, false]);
    // Assigning the Engineer position later makes them eligible at once.
    const patched = await send('patch', `/api/staff/${tech}`, { position: 'engineer' }, 'admin');
    expect(patched.status).toBe(200);
    expect((await effective(tech))[0]).toEqual([FIELD, true]);
    // Disable for the later tests.
    const ruleId = positionRulesSchema.parse(rule.body).active[0]!.id;
    expect(
      (
        await send(
          'delete',
          `/api/review-eligibility/position-rules/${ruleId}`,
          { reason: 'Back to individual grants' },
          'admin',
        )
      ).status,
    ).toBe(200);
  });

  it('the four conditions: eligible, on the team, accepted, and approved by the lead', async () => {
    const id = await person('Fay Fourway');
    await grant(id);
    const assignment = await assign('a', id);
    // Not on the team: the lead can't approve, and nothing reviews.
    expect((await approve('a', assignment)).body.code).toBe('not_accepted_member');
    // Pending membership (a MISC-07 self-join) is not enough either.
    const joined = await send(
      'post',
      projectPath('a', 'team-join-requests'),
      { idempotencyKey: newKey() },
      id,
    );
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect((await approve('a', assignment)).body.code).toBe('not_accepted_member');
    expect(await scopesOf('a', id)).toEqual([]);
    // Accepted: still not a reviewer until the lead approves; an admin can't approve.
    const requests = await h
      .http()
      .get(projectPath('a', 'team-join-requests'))
      .set('Cookie', cookies.pe!);
    const requestId = requests.body.pending[0].id as string;
    expect(
      (await send('post', projectPath('a', `team-join-requests/${requestId}/accept`), {}, 'pe'))
        .status,
    ).toBeLessThan(300);
    expect(await scopesOf('a', id)).toEqual([]);
    expect((await approve('a', assignment, 'admin')).status).toBe(403);
    const reviewers = projectReviewersSchema.parse(
      (await h.http().get(projectPath('a', 'reviewer-assignments')).set('Cookie', cookies.pe!))
        .body,
    );
    expect(reviewers.active.find((r) => r.id === assignment)).toMatchObject({
      eligible: true,
      acceptedMember: true,
      approval: null,
      blockedReason: 'not_approved',
      effective: false,
    });
    expect((await approve('a', assignment)).status).toBe(201);
    expect(await scopesOf('a', id)).toEqual([FIELD]);
    // Scope and project isolation: nothing in STRENGTH, nothing on B.
    expect(await scopesOf('b', id)).toEqual([]);
  });

  it('an exclusion overrides grants and rules; one scope or all; removing it approves nothing', async () => {
    const { id } = await reviewer('Xan Excluded', 'engineer');
    await grant(id, STRENGTH);
    const scoped = await exclude(id, STRENGTH);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(201);
    expect(await effective(id)).toEqual([
      [FIELD, true],
      [STRENGTH, false],
    ]);
    // A STRENGTH-only exclusion leaves FIELD approvals alone.
    expect(await approvals(id)).toEqual([{ ended: false, end_kind: null }]);
    const all = await exclude(id, null);
    expect(all.status).toBe(201);
    const grants = staffGrantsSchema.parse(all.body);
    expect(grants.exclusions.active.map((x) => x.scope?.code ?? null).sort()).toEqual(
      [STRENGTH, null].sort(),
    );
    expect(await effective(id)).toEqual([
      [FIELD, false],
      [STRENGTH, false],
    ]);
    // Actual loss: approval ended, live check refuses at once, the lead is asked to reassign.
    expect(await approvals(id)).toEqual([{ ended: true, end_kind: 'eligibility_lost' }]);
    expect(await scopesOf('a', id)).toEqual([]);
    const { rows: items } = await h.db.pool.query(
      `SELECT target_user_id, status FROM action_item
       WHERE kind = 'review_approval_lost' AND project_id = $1 AND reason LIKE '%Xan Excluded%'`,
      [h.projects.a],
    );
    expect(items).toEqual([{ target_user_id: h.users.pe, status: 'open' }]);

    // Removing every exclusion restores eligibility but never the approval.
    for (const x of grants.exclusions.active) {
      const removed = await send(
        'delete',
        `/api/staff/${id}/reviewer-exclusions/${x.id}`,
        { reason: 'Review finished' },
        'admin',
      );
      expect(removed.status).toBe(200);
    }
    expect((await effective(id))[0]).toEqual([FIELD, true]);
    expect(await scopesOf('a', id)).toEqual([]);
    // Fresh approval is needed (membership stays), and it settles the reassign request.
    const assignment = projectReviewersSchema
      .parse(
        (await h.http().get(projectPath('a', 'reviewer-assignments')).set('Cookie', cookies.pe!))
          .body,
      )
      .active.find((r) => r.reviewer.userId === id)!;
    expect(assignment.acceptedMember).toBe(true);
    expect((await approve('a', assignment.id)).status).toBe(201);
    expect(await scopesOf('a', id)).toEqual([FIELD]);
    const { rows: settled } = await h.db.pool.query(
      `SELECT status, resolution FROM action_item
       WHERE kind = 'review_approval_lost' AND reason LIKE '%Xan Excluded%'`,
    );
    expect(settled).toEqual([{ status: 'resolved', resolution: 'reassigned' }]);
  });

  it('losing one source while another remains is no loss; losing the last one is', async () => {
    const { id } = await reviewer('Sam Twosource', 'engineer');
    const rule = positionRulesSchema.parse((await enableRule('engineer')).body).active[0]!;
    const grants = staffGrantsSchema.parse(
      (await h.http().get(`/api/staff/${id}/grants`).set('Cookie', cookies.admin!)).body,
    );
    const revoked = await send(
      'delete',
      `/api/staff/${id}/reviewer-eligibility/${grants.reviewerEligibility.active[0]!.id}`,
      { reason: 'Replaced by the position rule' },
      'admin',
    );
    expect(revoked.status).toBe(200);
    expect(await approvals(id)).toEqual([{ ended: false, end_kind: null }]);
    expect(await scopesOf('a', id)).toEqual([FIELD]);
    // Now the position is the only source: a position change is an actual loss.
    expect(
      (await send('patch', `/api/staff/${id}`, { position: 'technician' }, 'admin')).status,
    ).toBe(200);
    expect(await approvals(id)).toEqual([{ ended: true, end_kind: 'eligibility_lost' }]);
    expect(await scopesOf('a', id)).toEqual([]);
    await send(
      'delete',
      `/api/review-eligibility/position-rules/${rule.id}`,
      { reason: 'Test finished' },
      'admin',
    );
    // History keeps the ended approval and the audit names the change.
    const { rows } = await h.db.pool.query(
      `SELECT reason FROM audit_event WHERE action = 'project_review_approval.ended'
       AND after_values ->> 'userId' = $1`,
      [id],
    );
    expect(rows[0].reason).toMatch(
      /^Review eligibility lost: position changed from engineer to technician/,
    );
  });

  describe('race: an approval and an eligibility loss never interleave', () => {
    let blocker: Client;
    beforeEach(async () => {
      blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
      await blocker.connect();
    });
    afterEach(async () => {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    });
    async function waitForLockWait(text: string) {
      for (let i = 0; i < 2000; i += 1) {
        const { rows } = await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
          [`%${text}%`],
        );
        if (rows[0]!.n > 0) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`nothing waited on ${text}`);
    }

    it('an exclusion that commits first refuses the late approval', async () => {
      const id = await person('Rae Race');
      await grant(id);
      await join('a', id);
      const assignment = await assign('a', id);
      await blocker.query('BEGIN');
      await blocker.query('SELECT review_eligibility_lock()');
      await blocker.query(
        `INSERT INTO reviewer_exclusion (user_id, user_name_snapshot, granted_by_user_id,
           granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
         VALUES ($1, 'Rae Race', $2, 'Admin (test)', 'Paused', gen_random_uuid(), 'h')`,
        [id, h.users.admin],
      );
      const late = approve('a', assignment);
      await waitForLockWait('review_eligibility_lock');
      await blocker.query('COMMIT');
      const refused = await late;
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('not_eligible');
      expect(await approvals(id)).toEqual([]);
    });

    it('an approval that commits first is ended by the late exclusion', async () => {
      const id = await person('Ray Race');
      await grant(id);
      await join('a', id);
      const assignment = await assign('a', id);
      await blocker.query('BEGIN');
      await blocker.query('SELECT review_eligibility_lock()');
      const late = exclude(id, FIELD);
      await waitForLockWait('review_eligibility_lock');
      // The approval lands while the exclusion waits (the database check allows it: no exclusion
      // has committed yet), then the exclusion sees and ends it.
      await blocker.query(
        `INSERT INTO project_review_approval (project_id, reviewer_assignment_id, reviewer_user_id,
           reviewer_name_snapshot, scope_code, approved_by_user_id, approved_by_name_snapshot,
           approve_idempotency_key, approve_request_hash)
         VALUES ($1, $2, $3, 'Ray Race', $4, $5, 'Pat Example', gen_random_uuid(), 'h')`,
        [h.projects.a, assignment, id, FIELD, h.users.pe],
      );
      await blocker.query('COMMIT');
      expect((await late).status).toBe(201);
      expect(await approvals(id)).toEqual([{ ended: true, end_kind: 'eligibility_lost' }]);
    });
  });

  it('the database refuses an approval by anyone but the lead, or for an ineligible reviewer', async () => {
    const id = await person('Dee Database');
    await join('a', id);
    await grant(id);
    const assignment = await assign('a', id);
    const insert = (by: string) =>
      h.db.pool.query(
        `INSERT INTO project_review_approval (project_id, reviewer_assignment_id, reviewer_user_id,
           reviewer_name_snapshot, scope_code, approved_by_user_id, approved_by_name_snapshot,
           approve_idempotency_key, approve_request_hash)
         VALUES ($1, $2, $3, 'Dee Database', $4, $5, 'Someone', gen_random_uuid(), 'h')`,
        [h.projects.a, assignment, id, FIELD, by],
      );
    await expect(insert(h.users.admin)).rejects.toMatchObject({
      constraint: 'project_review_approval_by_lead',
    });
    await exclude(id, null);
    await expect(insert(h.users.pe)).rejects.toMatchObject({
      constraint: 'project_review_approval_eligible',
    });
  });

  it('removing an assignment ends its approval; completed history stays', async () => {
    const { id, assignment } = await reviewer('Ada Assigned');
    const removed = await send(
      'delete',
      projectPath('a', `reviewer-assignments/${assignment}`),
      { reason: 'Moved to another project' },
      'admin',
    );
    expect(removed.status).toBe(200);
    expect(await approvals(id)).toEqual([{ ended: true, end_kind: 'assignment_ended' }]);
    const view = projectReviewersSchema.parse(removed.body);
    expect(view.approvalHistory.find((a) => a.reviewer.userId === id)).toMatchObject({
      endKind: 'assignment_ended',
      endReason: 'Moved to another project',
    });
  });
});
