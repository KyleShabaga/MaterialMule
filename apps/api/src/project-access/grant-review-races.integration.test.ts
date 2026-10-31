import { projectDetailSchema, projectGrantReviewsSchema } from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { insertProject } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { REENABLE_REVOKE_REASON } from './grant-tables.js';

// Review fixes on PR #118 (MTR-25, MISC-07): concurrent decisions settle the "Review inherited
// grants" request exactly once, and the routes that end the same grant or membership take their
// locks in one order (project, accounts, the project's grant-review lock, grant or membership,
// then the flag or join request), so they never deadlock. A blocker connection holds a row lock
// so both requests are in flight, queued at known locks, before either can commit; the tests wait
// on pg_stat_activity, never on time. Fictional data only: fresh projects led by Pat Example
// (`pe`), handed to Lee Manager (`lm`); Jordan (`js`) and Jamie (`jo`) hold the grants.
describe.runIf(testDatabaseUrl)('grant review and team join races (PR #118 review)', () => {
  let h: LabHarness;
  let blocker: Client;
  let serial = 0;

  const ok = (response: { status: number; body: unknown }, status = 201) =>
    expect(response.status, JSON.stringify(response.body)).toBe(status);

  async function project(): Promise<string> {
    serial += 1;
    return insertProject(h.db.pool, `RACE-${String(serial).padStart(3, '0')}`, h.users.pe);
  }

  async function grantDelegate(projectId: string, who: 'js' | 'jo'): Promise<string> {
    const response = await h.send(
      'post',
      `/api/projects/${projectId}/acceptance-delegates`,
      { delegateUserId: h.users[who], reason: 'Covers acceptance', idempotencyKey: newKey() },
      'pe',
    );
    ok(response);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM acceptance_delegation
       WHERE project_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL`,
      [projectId, h.users[who]],
    );
    return rows[0]!.id;
  }

  async function grantIssuer(projectId: string, who: 'js' | 'jo'): Promise<string> {
    const response = await h.send(
      'post',
      `/api/projects/${projectId}/report-issuers`,
      {
        issuerUserId: h.users[who],
        scopeCode: 'concrete_field',
        reason: 'Signs field reports',
        idempotencyKey: newKey(),
      },
      'pe',
    );
    ok(response);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM project_report_issuer_grant
       WHERE project_id = $1 AND issuer_user_id = $2 AND revoked_at IS NULL`,
      [projectId, h.users[who]],
    );
    return rows[0]!.id;
  }

  async function handToLm(projectId: string) {
    const version = projectDetailSchema.parse(
      (await h.get(`/api/projects/${projectId}`, 'admin')).body,
    ).version;
    ok(
      await h.send(
        'patch',
        `/api/projects/${projectId}`,
        { version, leadProjectEngineerId: h.users.lm, reason: 'Pat moved office' },
        'admin',
      ),
      200,
    );
  }

  async function pending(projectId: string) {
    const response = await h.get(`/api/projects/${projectId}/grant-reviews`, 'lm');
    ok(response, 200);
    return projectGrantReviewsSchema.parse(response.body).pending;
  }

  const decide = (projectId: string, id: string, action: 'keep' | 'revoke', reason: string) =>
    h.send('post', `/api/projects/${projectId}/grant-reviews/${id}/${action}`, { reason }, 'lm');

  async function flags(projectId: string) {
    const { rows } = await h.db.pool.query<{
      grant: string;
      status: string;
      decision_reason: string | null;
    }>(
      `SELECT COALESCE(acceptance_delegation_id, report_issuer_grant_id, reviewer_assignment_id)
                AS grant, status, decision_reason
       FROM project_grant_review WHERE project_id = $1 ORDER BY flagged_at, id`,
      [projectId],
    );
    return rows;
  }

  async function reviewItems(projectId: string) {
    const { rows } = await h.db.pool.query<{ status: string; resolution: string | null }>(
      `SELECT status, resolution FROM action_item
       WHERE kind = 'grant_review' AND project_id = $1 ORDER BY created_at, id`,
      [projectId],
    );
    return rows;
  }

  async function auditCount(entityType: string, entityId: string, action: string) {
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE entity_type = $1 AND entity_id = $2 AND action = $3`,
      [entityType, entityId, action],
    );
    return rows[0]!.n;
  }

  /** Resolves once `n` backends wait on a heavyweight lock in SQL mentioning one of `texts`. */
  async function waiters(n: number, texts: string[]) {
    for (let i = 0; i < 5000; i += 1) {
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
           AND query ILIKE ANY ($1::text[])`,
        [texts.map((t) => `%${t}%`)],
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`fewer than ${n} backends waited on ${texts.join(', ')}`);
  }

  /** Holds these projects' grant-review locks (migration 0009) in the blocker's transaction. */
  async function holdReviewLocks(projectIds: string[]) {
    for (const id of [...projectIds].sort()) {
      await blocker.query('SELECT project_grant_review_lock($1)', [id]);
    }
  }

  async function disable(who: 'js' | 'jo') {
    ok(
      await h.send('post', `/api/staff/${h.users[who]}/disable`, { reason: 'On leave' }, 'admin'),
      200,
    );
  }
  const enable = (who: 'js' | 'jo') =>
    h.send('post', `/api/staff/${h.users[who]}/enable`, {}, 'admin');

  beforeAll(async () => {
    h = await createLabHarness();
    blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await blocker.connect();
  }, 60_000);

  afterEach(async () => {
    await blocker.query('ROLLBACK').catch(() => undefined);
  });

  afterAll(async () => {
    await blocker?.end();
    await h?.close();
  });

  it('the last two flags decided at once resolve the request exactly once', async () => {
    const projectId = await project();
    await grantDelegate(projectId, 'js');
    await grantIssuer(projectId, 'jo');
    await handToLm(projectId);
    const [first, second] = await pending(projectId);
    expect(await reviewItems(projectId)).toEqual([{ status: 'open', resolution: null }]);

    // Both decisions are in flight, each queued at the project's grant-review lock, before either
    // can read or settle a flag.
    await blocker.query('BEGIN');
    await holdReviewLocks([projectId]);
    const a = decide(projectId, first!.id, 'keep', 'Still needed');
    const b = decide(projectId, second!.id, 'keep', 'Still needed too');
    await waiters(2, ['project_grant_review_lock']);
    await blocker.query('COMMIT');

    ok(await a, 200);
    ok(await b, 200);
    expect((await flags(projectId)).map((f) => f.status)).toEqual(['kept', 'kept']);
    expect(await reviewItems(projectId)).toEqual([{ status: 'resolved', resolution: 'reviewed' }]);
    for (const review of [first!, second!]) {
      expect(await auditCount('project_grant_review', review.id, 'project_grant_review.kept')).toBe(
        1,
      );
    }
  });

  it('database: two writers deciding the last two flags, interleaved, leave the request resolved', async () => {
    // Any writer (not only the API) is serialised by the settle function itself: the second
    // settle waits for the first writer's commit, then re-checks in a fresh snapshot.
    const projectId = await project();
    await grantDelegate(projectId, 'js');
    await grantIssuer(projectId, 'jo');
    await handToLm(projectId);
    const [first, second] = await pending(projectId);
    const one = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    const two = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
    await one.connect();
    await two.connect();
    const keep = (c: Client, id: string) =>
      c.query(
        `UPDATE project_grant_review
         SET status = 'kept', decided_at = now(), decided_by_user_id = $2,
             decided_by_name_snapshot = 'Lee Manager', decision_reason = 'Still needed'
         WHERE id = $1`,
        [id, h.users.lm],
      );
    const settle = (c: Client) =>
      c.query('SELECT project_grant_review_settle($1, $2)', [projectId, h.users.lm]);
    try {
      await one.query('BEGIN');
      await keep(one, first!.id);
      await two.query('BEGIN');
      await keep(two, second!.id);
      // One settles while the other's decision is still uncommitted: the request stays open.
      await settle(one);
      const settling = settle(two);
      await waiters(1, ['project_grant_review_settle']);
      await one.query('COMMIT');
      await settling;
      await two.query('COMMIT');
    } finally {
      await one.query('ROLLBACK').catch(() => undefined);
      await two.query('ROLLBACK').catch(() => undefined);
      await one.end();
      await two.end();
    }
    expect(await reviewItems(projectId)).toEqual([{ status: 'resolved', resolution: 'reviewed' }]);
  });

  it('Revoke on review racing an ordinary revocation of the same grant: one ending, no deadlock', async () => {
    const projectId = await project();
    await grantDelegate(projectId, 'js');
    const issuer = await grantIssuer(projectId, 'jo');
    await handToLm(projectId);
    const review = (await pending(projectId)).find((r) => r.grantId === issuer)!;

    // The ordinary revocation queues at the grant first, then the review's Revoke.
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM project_report_issuer_grant WHERE id = $1 FOR UPDATE', [
      issuer,
    ]);
    // Both by the new lead, told apart by their reasons.
    const removing = h
      .http()
      .delete(`/api/projects/${projectId}/report-issuers/${issuer}`)
      .set('Cookie', await h.cookie('lm'))
      .set('x-materialmule-csrf', '1')
      .send({ reason: 'Removed directly' })
      .then((r) => r);
    await waiters(1, ['project_report_issuer_grant']);
    const revoking = decide(projectId, review.id, 'revoke', 'Revoked on review');
    await waiters(2, ['project_report_issuer_grant', 'project_grant_review']);
    await blocker.query('COMMIT');

    const [removed, revoked] = await Promise.all([removing, revoking]);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect([200, 409], JSON.stringify(revoked.body)).toContain(revoked.status);

    // Ended once, by whichever committed first; the flag carries that ending.
    const { rows } = await h.db.pool.query<{ revoke_reason: string }>(
      'SELECT revoke_reason FROM project_report_issuer_grant WHERE id = $1 AND revoked_at IS NOT NULL',
      [issuer],
    );
    expect(rows).toHaveLength(1);
    expect(
      await auditCount(
        'project_report_issuer_grant',
        issuer,
        'project_report_issuer_grant.revoked',
      ),
    ).toBe(1);
    const flag = (await flags(projectId)).find((f) => f.grant === issuer)!;
    expect(flag).toMatchObject({ status: 'revoked', decision_reason: rows[0]!.revoke_reason });
    // If the ordinary revocation won, the same person's Revoke reads as a retry of that decision
    // (200) and records nothing more; either way there is exactly one decision.
    const viaReview = rows[0]!.revoke_reason === 'Revoked on review';
    if (viaReview) expect(revoked.status).toBe(200);
    expect(
      await auditCount('project_grant_review', review.id, 'project_grant_review.revoked'),
    ).toBe(viaReview ? 1 : 0);
    // The delegate's flag is still pending, so the request stays open.
    expect(await reviewItems(projectId)).toEqual([{ status: 'open', resolution: null }]);
  });

  it('Decline racing an ordinary removal of the same membership: one removal, no deadlock', async () => {
    const projectId = await project();
    ok(
      await h.send(
        'post',
        `/api/projects/${projectId}/team-join-requests`,
        { idempotencyKey: newKey() },
        'js',
      ),
    );
    const { rows: requests } = await h.db.pool.query<{ id: string; team_member_id: string }>(
      `SELECT id, team_member_id FROM project_team_join_request WHERE project_id = $1`,
      [projectId],
    );
    const request = requests[0]!;

    // The ordinary removal queues at the membership first, then the Decline.
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM project_team_member WHERE id = $1 FOR UPDATE', [
      request.team_member_id,
    ]);
    const removing = h
      .http()
      .delete(`/api/projects/${projectId}/team-members/${request.team_member_id}`)
      .set('Cookie', await h.cookie('admin'))
      .set('x-materialmule-csrf', '1')
      .send({ reason: 'Removed directly' })
      .then((r) => r);
    await waiters(1, ['project_team_member']);
    const declining = h.send(
      'post',
      `/api/projects/${projectId}/team-join-requests/${request.id}/decline`,
      { reason: 'Not on this project' },
      'pe',
    );
    await waiters(2, ['project_team_member', 'project_team_join_request']);
    await blocker.query('COMMIT');

    const [removed, declined] = await Promise.all([removing, declining]);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect([200, 409], JSON.stringify(declined.body)).toContain(declined.status);

    const { rows: member } = await h.db.pool.query<{ remove_reason: string }>(
      'SELECT remove_reason FROM project_team_member WHERE id = $1 AND removed_at IS NOT NULL',
      [request.team_member_id],
    );
    expect(member).toHaveLength(1);
    expect(
      await auditCount(
        'project_team_member',
        request.team_member_id,
        'project_team_member.removed',
      ),
    ).toBe(1);
    const { rows: after } = await h.db.pool.query<{ status: string; decision_reason: string }>(
      'SELECT status, decision_reason FROM project_team_join_request WHERE id = $1',
      [request.id],
    );
    expect(after[0]).toEqual({ status: 'declined', decision_reason: member[0]!.remove_reason });
    const viaDecline = member[0]!.remove_reason === 'Not on this project';
    expect(declined.status).toBe(viaDecline ? 200 : 409);
    expect(
      await auditCount(
        'project_team_join_request',
        request.id,
        'project_team_join_request.declined',
      ),
    ).toBe(viaDecline ? 1 : 0);
    const { rows: item } = await h.db.pool.query<{ status: string; resolution: string }>(
      `SELECT status, resolution FROM action_item WHERE kind = 'team_join_request' AND entity_id = $1`,
      [request.id],
    );
    expect(item).toEqual([{ status: 'resolved', resolution: 'declined' }]);
  });

  it('a re-enable revoking one flagged grant while the other flag is kept resolves the request', async () => {
    const projectId = await project();
    const delegation = await grantDelegate(projectId, 'js');
    const issuer = await grantIssuer(projectId, 'jo');
    await handToLm(projectId);
    const issuerReview = (await pending(projectId)).find((r) => r.grantId === issuer)!;
    await disable('js');

    // The re-enable (ending the delegation) and the Keep (the last other flag) both wait at the
    // project's grant-review lock.
    await blocker.query('BEGIN');
    await holdReviewLocks([projectId]);
    const enabling = enable('js');
    const keeping = decide(projectId, issuerReview.id, 'keep', 'Jamie still signs');
    await waiters(2, ['project_grant_review_lock']);
    await blocker.query('COMMIT');

    ok(await enabling, 200);
    ok(await keeping, 200);
    const all = await flags(projectId);
    expect(all.find((f) => f.grant === delegation)).toMatchObject({
      status: 'revoked',
      decision_reason: REENABLE_REVOKE_REASON,
    });
    expect(all.find((f) => f.grant === issuer)).toMatchObject({ status: 'kept' });
    expect(await reviewItems(projectId)).toEqual([{ status: 'resolved', resolution: 'reviewed' }]);
    expect(
      await auditCount('acceptance_delegation', delegation, 'acceptance_delegation.revoked'),
    ).toBe(1);
  });

  it('two re-enables whose grants share two projects both commit and settle both requests', async () => {
    const p1 = await project();
    const p2 = await project();
    for (const p of [p1, p2]) {
      await grantDelegate(p, 'js');
      await grantDelegate(p, 'jo');
      await handToLm(p);
    }
    await disable('js');
    await disable('jo');

    // Each re-enable takes both projects' locks in id order, so one waits for the other wholly.
    await blocker.query('BEGIN');
    await holdReviewLocks([p1, p2]);
    const a = enable('js');
    const b = enable('jo');
    await waiters(2, ['project_grant_review_lock']);
    await blocker.query('COMMIT');

    const [first, second] = await Promise.all([a, b]);
    ok(first, 200);
    ok(second, 200);
    for (const p of [p1, p2]) {
      expect((await flags(p)).map((f) => f.status)).toEqual(['revoked', 'revoked']);
      expect(await reviewItems(p)).toEqual([{ status: 'resolved', resolution: 'reviewed' }]);
    }
  });
});
