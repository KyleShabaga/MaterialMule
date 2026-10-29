import {
  labProgramReviewSchema,
  labProgramSchema,
  projectCapabilitiesSchema,
  projectReportIssuersSchema,
  projectReviewersSchema,
  projectTeamSchema,
  staffGrantsSchema,
} from '@materialmule/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { databaseUrlForSchema, testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-AO03 central authorization for project assignments and scoped grants (card AC1–AC4, test
// plan §8). Real PostgreSQL, direct API calls; races use a second real connection and row locks,
// never sleeps. Fictional data only: DEMO-2601 (A, Lead Project Engineer Pat Example `pe`) and
// DEMO-2602 (B, led here by Jordan Smith `js`). Extra fictional staff play a team member, a
// scoped reviewer, an acceptance delegate and an Authorized report issuer on A.
describe.runIf(testDatabaseUrl)('project assignments and scoped grants API (MM-AO03)', () => {
  let h: LabHarness;
  let moisture: string;
  const people: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  type Caller =
    | 'anonymous'
    | 'pending'
    | 'disabled'
    | 'lab'
    | 'tech'
    | 'lm'
    | 'admin'
    | 'pe'
    | 'js'
    | 'team'
    | 'rev'
    | 'del'
    | 'iss';

  // Async, so each request starts at once (a bare supertest request waits to be awaited).
  const send = async (
    method: 'post' | 'delete',
    path: string,
    body: unknown,
    as: Caller | string,
  ) => {
    const req = h.http()[method](path).set(CSRF_HEADER, '1');
    const cookie = as === 'anonymous' ? null : as.startsWith(SESSION_COOKIE) ? as : cookies[as];
    if (cookie) req.set('Cookie', cookie);
    return req.send(body as object);
  };
  const get = async (path: string, as: Caller) => {
    const req = h.http().get(path);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };

  const projectPath = (project: 'a' | 'b', rest: string) =>
    `/api/projects/${h.projects[project]}/${rest}`;

  const addTeam = (project: 'a' | 'b', userId: string, as: Caller, key = newKey()) =>
    send(
      'post',
      projectPath(project, 'team-members'),
      { userId, reason: 'Supporting engineer on site', idempotencyKey: key },
      as,
    );
  const assignReviewer = (
    project: 'a' | 'b',
    reviewerUserId: string,
    as: Caller,
    scopeCode = 'concrete_field',
  ) =>
    send(
      'post',
      projectPath(project, 'reviewer-assignments'),
      { reviewerUserId, scopeCode, reason: 'Reviews field reports', idempotencyKey: newKey() },
      as,
    );
  const grantIssuer = (
    project: 'a' | 'b',
    issuerUserId: string,
    as: Caller,
    extra: Record<string, unknown> = {},
  ) =>
    send(
      'post',
      projectPath(project, 'report-issuers'),
      {
        issuerUserId,
        scopeCode: 'concrete_field',
        reason: 'Signs field reports while the lead is away',
        idempotencyKey: newKey(),
        ...extra,
      },
      as,
    );
  const grantEligibility = (userId: string, scopeCode = 'concrete_field', as: Caller = 'admin') =>
    send(
      'post',
      `/api/staff/${userId}/reviewer-eligibility`,
      { scopeCode, reason: 'Qualified field reviewer', idempotencyKey: newKey() },
      as,
    );

  async function capabilities(project: 'a' | 'b', as: Caller) {
    const response = await get(projectPath(project, 'capabilities'), as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectCapabilitiesSchema.parse(response.body);
  }

  const allowed = (caps: { capabilities: { action: string; allowed: boolean }[] }) =>
    caps.capabilities.filter((c) => c.allowed).map((c) => c.action);

  /** Every row of every assignment/grant table plus the audit log. */
  async function snapshot() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM project_team_member) AS team,
              (SELECT count(*)::int FROM project_reviewer_assignment) AS reviewers,
              (SELECT count(*)::int FROM project_report_issuer_grant) AS issuers,
              (SELECT count(*)::int FROM reviewer_eligibility) AS eligibility,
              (SELECT count(*)::int FROM staff_capability_grant) AS capabilities,
              (SELECT count(*)::int FROM acceptance_delegation) AS delegations,
              (SELECT count(*)::int FROM project_team_member WHERE removed_at IS NOT NULL)
                AS team_ended,
              (SELECT count(*)::int FROM project_report_issuer_grant WHERE revoked_at IS NOT NULL)
                AS issuers_ended,
              (SELECT count(*)::int FROM audit_event) AS audit`,
    );
    return rows[0];
  }

  async function addPerson(key: string, name: string, initials: string | null, status = 'active') {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
    people[key] = rows[0]!.id;
    return rows[0]!.id;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC-AO3', 'Moisture content (fictional)', 'Moisture')).id;
    const sessions = h.app.get(SessionService);
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab', 'disabled'] as const) {
      people[key] = h.users[key];
      cookies[key] = await h.cookie(key);
    }
    await addPerson('pending', 'Pending Applicant', 'PA', 'pending');
    await addPerson('team', 'Taylor Member', 'TM');
    await addPerson('rev', 'Riley Reviewer', 'RR');
    await addPerson('del', 'Dakota Delegate', 'DD');
    await addPerson('iss', 'Iris Issuer', 'II');
    for (const key of ['pending', 'team', 'rev', 'del', 'iss']) {
      const session = await sessions.create(people[key]!, 'personal');
      cookies[key] = `${SESSION_COOKIE}=${session.token}`;
    }
    // B is led by Jordan Smith, so pe is a wrong-project caller there and js one on A.
    await h.db.pool.query('UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1', [
      h.projects.b,
      h.users.js,
    ]);
    // The cast on A, set up through the API.
    expect((await addTeam('a', people.team!, 'pe')).status).toBe(201);
    expect((await grantEligibility(people.rev!)).status).toBe(201);
    expect((await assignReviewer('a', people.rev!, 'pe')).status).toBe(201);
    expect((await grantIssuer('a', people.iss!, 'pe')).status).toBe(201);
    const delegated = await send(
      'post',
      projectPath('a', 'acceptance-delegates'),
      { delegateUserId: people.del, reason: 'Covers acceptance', idempotencyKey: newKey() },
      'pe',
    );
    expect(delegated.status, JSON.stringify(delegated.body)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // AC1: direct requests by every kind of caller; refusals write nothing
  // ---------------------------------------------------------------------------------------------

  it('AC1: only the lead or an admin manage the team and reviewers, and only the lead grants issuers', async () => {
    const outsider = await addPerson(`out-${newKey().slice(0, 6)}`, 'Olive Outsider', 'OO');
    const expectations: [Caller, 401 | 403, string][] = [
      ['anonymous', 401, 'unauthenticated'],
      ['disabled', 401, 'unauthenticated'],
      ['pending', 403, 'access_pending'],
      ['lab', 403, 'forbidden'],
      ['tech', 403, 'forbidden'],
      ['lm', 403, 'forbidden'],
      // js leads B, not A: a wrong-project lead.
      ['js', 403, 'forbidden'],
      ['team', 403, 'forbidden'],
      ['rev', 403, 'forbidden'],
      ['del', 403, 'forbidden'],
      ['iss', 403, 'forbidden'],
    ];
    const before = await snapshot();
    for (const [caller, status, code] of expectations) {
      for (const response of [
        await addTeam('a', outsider, caller),
        await assignReviewer('a', people.rev!, caller, 'concrete_strength'),
        await grantIssuer('a', outsider, caller),
      ]) {
        expect(response.status, `${caller}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(response.body.code).toBe(code);
      }
    }
    // Admin manages team and reviewers but has no issuer authority (D06).
    const adminIssuer = await grantIssuer('a', outsider, 'admin');
    expect(adminIssuer.status).toBe(403);
    expect(await snapshot()).toEqual(before);

    // Removals and revocations are refused the same way, before the body is read.
    const team = projectTeamSchema.parse((await get(projectPath('a', 'team-members'), 'pe')).body);
    const issuers = projectReportIssuersSchema.parse(
      (await get(projectPath('a', 'report-issuers'), 'pe')).body,
    );
    for (const caller of ['tech', 'lm', 'js', 'team', 'iss', 'lab'] as const) {
      expect(
        (
          await send(
            'delete',
            projectPath('a', `team-members/${team.active[0]!.id}`),
            { reason: 'x' },
            caller,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            'delete',
            projectPath('a', `report-issuers/${issuers.active[0]!.id}`),
            {},
            caller,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await send(
          'delete',
          projectPath('a', `report-issuers/${issuers.active[0]!.id}`),
          { reason: 'x' },
          'admin',
        )
      ).status,
    ).toBe(403);
    expect(await snapshot()).toEqual(before);

    // The lead and an admin may add a team member.
    expect((await addTeam('a', outsider, 'admin')).status).toBe(201);
  });

  it('AC1: wrong-project row IDs and unknown projects are refused without changing anything', async () => {
    const team = projectTeamSchema.parse((await get(projectPath('a', 'team-members'), 'pe')).body);
    const rowOnA = team.active.find((m) => m.person.userId === people.team)!.id;
    const before = await snapshot();
    // js leads B and names A's row under B: not found, nothing ends.
    const wrong = await send(
      'delete',
      projectPath('b', `team-members/${rowOnA}`),
      { reason: 'Not on this project' },
      'js',
    );
    expect(wrong.status).toBe(404);
    expect(wrong.body.code).toBe('project_team_member_not_found');
    // An unknown project: 403 for someone who could never manage it, 404 for an admin.
    const missing = `/api/projects/${newKey()}/team-members`;
    const body = { userId: people.rev, reason: 'x', idempotencyKey: newKey() };
    expect((await send('post', missing, body, 'tech')).status).toBe(403);
    expect((await send('post', missing, body, 'admin')).status).toBe(404);
    expect((await send('post', '/api/projects/not-a-uuid/report-issuers', {}, 'pe')).status).toBe(
      403,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('validates recipients, scopes, expiry and reasons, and stacks no duplicates', async () => {
    const before = await snapshot();
    const cases: [Promise<{ status: number; body: { code: string } }>, number, string][] = [
      // D15: a reason is required.
      [
        send(
          'post',
          projectPath('a', 'team-members'),
          { userId: people.rev, idempotencyKey: newKey() },
          'pe',
        ),
        400,
        'validation_failed',
      ],
      // LAB, disabled and pending people can't hold an assignment or grant.
      [addTeam('a', h.users.lab, 'pe'), 422, 'invalid_recipient'],
      [addTeam('a', h.users.disabled, 'pe'), 422, 'invalid_recipient'],
      [addTeam('a', people.pending!, 'pe'), 422, 'invalid_recipient'],
      [addTeam('a', newKey(), 'pe'), 422, 'invalid_recipient'],
      [addTeam('a', h.users.pe, 'pe'), 422, 'invalid_recipient'],
      [addTeam('a', people.team!, 'pe'), 422, 'already_assigned'],
      // D05: only an eligible person, for an active scope.
      [assignReviewer('a', people.team!, 'pe'), 422, 'not_eligible'],
      [assignReviewer('a', people.rev!, 'pe', 'no_such_scope'), 422, 'invalid_scope'],
      [assignReviewer('a', people.rev!, 'pe'), 422, 'already_assigned'],
      // D06/D07: the lead issues inherently; expiry must be in the future.
      [grantIssuer('a', h.users.pe, 'pe'), 422, 'invalid_recipient'],
      [
        grantIssuer('a', people.team!, 'pe', { expiresAt: '2020-01-01T00:00:00Z' }),
        422,
        'invalid_expiry',
      ],
      [grantIssuer('a', people.iss!, 'pe'), 422, 'already_assigned'],
    ];
    for (const [pending, status, code] of cases) {
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      expect(response.body.code).toBe(code);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('exact retries return the same result; a reused key for another intent is 409', async () => {
    const person = await addPerson(`retry-${newKey().slice(0, 6)}`, 'Robin Retry', 'RT');
    const key = newKey();
    const first = await addTeam('a', person, 'pe', key);
    expect(first.status).toBe(201);
    const before = await snapshot();
    const again = await addTeam('a', person, 'pe', key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await snapshot()).toEqual(before);
    const reused = await send(
      'post',
      projectPath('a', 'team-members'),
      { userId: person, reason: 'Different reason', idempotencyKey: key },
      'pe',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    expect(await snapshot()).toEqual(before);
  });

  it('removal needs a reason, happens once, and keeps history with who, when and why', async () => {
    const person = await addPerson(`end-${newKey().slice(0, 6)}`, 'Eden Ender', 'EE');
    const added = projectTeamSchema.parse((await addTeam('a', person, 'pe')).body);
    const row = added.active.find((m) => m.person.userId === person)!;
    const path = projectPath('a', `team-members/${row.id}`);
    expect((await send('delete', path, {}, 'pe')).status).toBe(400);
    const removed = await send('delete', path, { reason: 'Left the project' }, 'admin');
    expect(removed.status).toBe(200);
    const after = projectTeamSchema.parse(removed.body);
    expect(after.active.some((m) => m.id === row.id)).toBe(false);
    expect(after.history.find((m) => m.id === row.id)).toMatchObject({
      startReason: 'Supporting engineer on site',
      endReason: 'Left the project',
      endedBy: { userId: h.users.admin, name: 'Admin Example' },
    });
    // Repeated removal changes nothing and writes no second audit event.
    const before = await snapshot();
    expect((await send('delete', path, { reason: 'Again' }, 'pe')).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const { rows } = await h.db.pool.query(
      `SELECT action, reason FROM audit_event WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [row.id],
    );
    expect(rows).toEqual([
      { action: 'project_team_member.added', reason: 'Supporting engineer on site' },
      { action: 'project_team_member.removed', reason: 'Left the project' },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // AC2: scoped grants confer nothing on another project or scope; expiry and revocation
  // ---------------------------------------------------------------------------------------------

  it('AC2: an issuer grant counts only for its project and scope, and only until it expires', async () => {
    const onA = await capabilities('a', 'iss');
    expect(onA.involvement).toEqual(['report_issuer']);
    expect(onA.issuerScopes.map((s) => s.code)).toEqual(['concrete_field']);
    const onB = await capabilities('b', 'iss');
    expect(onB.involvement).toEqual([]);
    expect(onB.issuerScopes).toEqual([]);
    // The lead issues in every scope on their own project without a grant (D07), nowhere else.
    expect((await capabilities('a', 'pe')).issuerScopes.map((s) => s.code)).toEqual([
      'concrete_field',
      'concrete_strength',
    ]);
    expect((await capabilities('b', 'pe')).issuerScopes).toEqual([]);

    // An expired grant is shown as such and confers nothing.
    const temp = await addPerson(`exp-${newKey().slice(0, 6)}`, 'Ezra Expiry', 'EX');
    const granted = await grantIssuer('a', temp, 'pe', {
      scopeCode: 'concrete_strength',
      approvalReference: 'QA-2026-114',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const grantId = projectReportIssuersSchema
      .parse(granted.body)
      .active.find((g) => g.issuer.userId === temp)!.id;
    const sessionTemp = await h.app.get(SessionService).create(temp, 'personal');
    const tempCookie = `${SESSION_COOKIE}=${sessionTemp.token}`;
    const live = projectCapabilitiesSchema.parse(
      (await h.http().get(projectPath('a', 'capabilities')).set('Cookie', tempCookie)).body,
    );
    expect(live.issuerScopes.map((s) => s.code)).toEqual(['concrete_strength']);

    // Emergency suspension is a revocation with its kind recorded; it takes effect at once.
    const suspended = await send(
      'delete',
      projectPath('a', `report-issuers/${grantId}`),
      { reason: 'Approval under review', kind: 'emergency' },
      'pe',
    );
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    expect(
      projectReportIssuersSchema.parse(suspended.body).history.find((g) => g.id === grantId),
    ).toMatchObject({
      revocationKind: 'emergency',
      approvalReference: 'QA-2026-114',
      endReason: 'Approval under review',
      effective: false,
    });
    const gone = projectCapabilitiesSchema.parse(
      (await h.http().get(projectPath('a', 'capabilities')).set('Cookie', tempCookie)).body,
    );
    expect(gone.issuerScopes).toEqual([]);
  });

  it('AC2: an already-expired grant is reported as expired and confers nothing', async () => {
    const temp = await addPerson(`old-${newKey().slice(0, 6)}`, 'Ollie Old', 'OL');
    // Written directly with a past expiry, as time passing would leave it.
    await h.db.pool.query(
      `INSERT INTO project_report_issuer_grant (project_id, issuer_user_id, issuer_name_snapshot,
         report_scope_code, granted_by_user_id, granted_by_name_snapshot, grant_reason, granted_at,
         expires_at, grant_idempotency_key, grant_request_hash)
       VALUES ($1, $2, 'Ollie Old', 'concrete_field', $3, 'Pat Example', 'Short cover',
               now() - interval '2 days', now() - interval '1 day', gen_random_uuid(), 'h')`,
      [h.projects.a, temp, h.users.pe],
    );
    const issuers = projectReportIssuersSchema.parse(
      (await get(projectPath('a', 'report-issuers'), 'tech')).body,
    );
    expect(issuers.canManage).toBe(false);
    expect(issuers.active.find((g) => g.issuer.userId === temp)).toMatchObject({
      effective: false,
      blockedReason: 'expired',
    });
    const session = await h.app.get(SessionService).create(temp, 'personal');
    const caps = projectCapabilitiesSchema.parse(
      (
        await h
          .http()
          .get(projectPath('a', 'capabilities'))
          .set('Cookie', `${SESSION_COOKIE}=${session.token}`)
      ).body,
    );
    expect(caps.issuerScopes).toEqual([]);
    expect(caps.involvement).toEqual([]);
  });

  it('a reviewer assignment counts only while the reviewer stays eligible for its scope', async () => {
    const person = await addPerson(`elig-${newKey().slice(0, 6)}`, 'Eli Eligible', 'EL');
    const eligibility = staffGrantsSchema.parse((await grantEligibility(person)).body);
    expect((await assignReviewer('a', person, 'admin')).status).toBe(201);
    const session = await h.app.get(SessionService).create(person, 'personal');
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    const caps = async () =>
      projectCapabilitiesSchema.parse(
        (await h.http().get(projectPath('a', 'capabilities')).set('Cookie', cookie)).body,
      );
    expect((await caps()).reviewerScopes.map((s) => s.code)).toEqual(['concrete_field']);
    expect((await caps()).involvement).toEqual(['reviewer']);
    // Revoking eligibility (admin, with a reason) blocks the assignment without deleting it.
    const revoked = await send(
      'delete',
      `/api/staff/${person}/reviewer-eligibility/${eligibility.reviewerEligibility.active[0]!.id}`,
      { reason: 'Qualification lapsed' },
      'admin',
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const reviewers = projectReviewersSchema.parse(
      (await get(projectPath('a', 'reviewer-assignments'), 'tech')).body,
    );
    expect(reviewers.active.find((r) => r.reviewer.userId === person)).toMatchObject({
      effective: false,
      blockedReason: 'eligibility_revoked',
    });
    expect((await caps()).reviewerScopes).toEqual([]);
    expect((await caps()).involvement).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // AC3: admin alone, LAB and memberships infer no technical authority
  // ---------------------------------------------------------------------------------------------

  it('AC3: effective capabilities report sources and blocked reasons; admin, LAB and membership add no technical authority', async () => {
    const lead = await capabilities('a', 'pe');
    expect(lead.involvement).toEqual(['lead_project_engineer']);
    expect(lead.capabilities.find((c) => c.action === 'program.close')).toEqual({
      action: 'program.close',
      allowed: true,
      sources: ['lead_project_engineer'],
      blocked: null,
    });

    const admin = await capabilities('a', 'admin');
    expect(allowed(admin)).toEqual([
      'project.edit',
      'project.lead_project_engineer.change',
      'project_team.manage',
      'project_reviewer.manage',
    ]);
    expect(admin.issuerScopes).toEqual([]);
    expect(admin.capabilities.find((c) => c.action === 'test.accept')).toEqual({
      action: 'test.accept',
      allowed: false,
      sources: [],
      blocked: {
        code: 'not_permitted',
        grantedBy: ['lead_project_engineer', 'acceptance_delegate'],
      },
    });
    expect(admin.capabilities.find((c) => c.action === 'report_issuer.manage')!.blocked).toEqual({
      code: 'not_permitted',
      grantedBy: ['lead_project_engineer'],
    });

    // Team membership and a reviewer assignment grant no project action at all.
    expect(allowed(await capabilities('a', 'team'))).toEqual([]);
    expect(allowed(await capabilities('a', 'rev'))).toEqual([]);
    // A delegate accepts and nothing else; the issuer only issues.
    expect(allowed(await capabilities('a', 'del'))).toEqual(['test.accept']);
    expect(allowed(await capabilities('a', 'iss'))).toEqual([]);
    expect(
      (await capabilities('a', 'del')).capabilities.find((c) => c.action === 'test.accept'),
    ).toMatchObject({ sources: ['acceptance_delegate'] });
    // The Lab Manager keeps exactly its existing project powers.
    expect(allowed(await capabilities('a', 'lm'))).toEqual([
      'program.reopen',
      'program.priority.set',
      'test.cancel',
      'retention.manage',
      'disposal.approve',
    ]);
    // LAB reads none of this (personal accounts only), whoever it selects.
    expect((await get(projectPath('a', 'capabilities'), 'lab')).status).toBe(403);
    expect((await get(projectPath('a', 'team-members'), 'lab')).status).toBe(403);
    expect((await get('/api/review-scopes', 'lab')).status).toBe(403);
    // Broad internal visibility: any personal account reads who is assigned.
    for (const path of ['team-members', 'reviewer-assignments', 'report-issuers']) {
      const read = await get(projectPath('a', path), 'tech');
      expect(read.status).toBe(200);
      expect(read.body.canManage).toBe(false);
    }
  });

  it('AC3: a job title, position or LAB selection never makes anyone an issuer or reviewer', async () => {
    await h.db.pool.query(
      `UPDATE app_user SET job_title = 'Senior Project Engineer', position = 'project_engineer',
              position_set_at = now() WHERE id = $1`,
      [h.users.tech],
    );
    const caps = await capabilities('a', 'tech');
    expect(caps.involvement).toEqual([]);
    expect(caps.issuerScopes).toEqual([]);
    expect(caps.reviewerScopes).toEqual([]);
    expect(allowed(caps)).toEqual([]);
    // LAB naming the lead as the acting person borrows nothing.
    const asLab = await send(
      'post',
      projectPath('a', 'team-members'),
      {
        userId: people.rev,
        reason: 'x',
        idempotencyKey: newKey(),
        actingStaffUserId: h.users.pe,
      },
      'lab',
    );
    expect(asLab.status).toBe(403);
  });

  // ---------------------------------------------------------------------------------------------
  // Staff-level grants (D01, D05) and D08 re-enable revalidation
  // ---------------------------------------------------------------------------------------------

  it('reviewer eligibility and the create-and-lead capability are admin-only, with reasons', async () => {
    const person = await addPerson(`cap-${newKey().slice(0, 6)}`, 'Casey Capable', 'CC');
    const body = {
      capability: 'project.create_and_lead',
      reason: 'Leads small projects',
      idempotencyKey: newKey(),
    };
    const before = await snapshot();
    for (const caller of ['tech', 'lm', 'pe', 'lab'] as const) {
      expect((await send('post', `/api/staff/${person}/capabilities`, body, caller)).status).toBe(
        403,
      );
      expect((await grantEligibility(person, 'concrete_field', caller)).status).toBe(403);
    }
    expect(
      (
        await send(
          'post',
          `/api/staff/${person}/capabilities`,
          { ...body, reason: ' ', idempotencyKey: newKey() },
          'admin',
        )
      ).status,
    ).toBe(400);
    expect((await grantEligibility(h.users.lab)).body.code).toBe('invalid_recipient');
    expect((await grantEligibility(person, 'nope')).body.code).toBe('invalid_scope');
    expect(await snapshot()).toEqual(before);

    const granted = await send('post', `/api/staff/${person}/capabilities`, body, 'admin');
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const grants = staffGrantsSchema.parse(granted.body);
    expect(grants.capabilities.active).toMatchObject([
      { capability: 'project.create_and_lead', startReason: 'Leads small projects' },
    ]);
    const duplicate = await send(
      'post',
      `/api/staff/${person}/capabilities`,
      { ...body, idempotencyKey: newKey() },
      'admin',
    );
    expect(duplicate.body.code).toBe('already_granted');
    // The person reads their own grants; nobody else's.
    const session = await h.app.get(SessionService).create(person, 'personal');
    const mine = await h
      .http()
      .get('/api/me/grants')
      .set('Cookie', `${SESSION_COOKIE}=${session.token}`);
    expect(staffGrantsSchema.parse(mine.body)).toMatchObject({ userId: person, canManage: false });
    expect((await get(`/api/staff/${person}/grants`, 'tech')).status).toBe(403);
  });

  it('MM-AO05: the reviewer lookup lists only active people eligible for the scope', async () => {
    const lookup = (scope: string, as: Caller, search = '') =>
      get(`/api/review-scopes/${scope}/eligible-reviewers${search ? `?search=${search}` : ''}`, as);
    const field = await lookup('concrete_field', 'pe');
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    const ids = (field.body as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(people.rev);
    // Team, delegate and issuer places don't make anyone a reviewer; LAB never appears.
    for (const key of ['team', 'del', 'iss', 'lab', 'pe']) expect(ids).not.toContain(people[key]);
    expect(field.body.find((p: { id: string }) => p.id === people.rev)).toMatchObject({
      initials: 'RR',
      displayName: 'Riley Reviewer',
    });
    expect(
      ((await lookup('concrete_field', 'pe', 'Riley')).body as { id: string }[]).map((p) => p.id),
    ).toEqual([people.rev]);
    expect((await lookup('concrete_field', 'pe', 'Nobody')).body).toEqual([]);
    // Another scope: Riley isn't eligible there.
    expect(
      ((await lookup('concrete_strength', 'pe')).body as { id: string }[]).map((p) => p.id),
    ).not.toContain(people.rev);
    expect((await lookup('nope', 'pe')).status).toBe(404);
    expect((await lookup('concrete_field', 'lab')).status).toBe(403);
    expect((await lookup('concrete_field', 'anonymous')).status).toBe(401);
  });

  it('D08: re-enabling a disabled account revokes its technical grants for revalidation; team membership stays', async () => {
    const person = await addPerson(`d08-${newKey().slice(0, 6)}`, 'Morgan Return', 'MR');
    await grantEligibility(person);
    expect((await assignReviewer('a', person, 'pe')).status).toBe(201);
    expect((await grantIssuer('a', person, 'pe')).status).toBe(201);
    expect((await addTeam('a', person, 'pe')).status).toBe(201);
    expect(
      (
        await send(
          'post',
          projectPath('a', 'acceptance-delegates'),
          { delegateUserId: person, reason: 'Covers acceptance', idempotencyKey: newKey() },
          'pe',
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await send(
          'post',
          `/api/staff/${person}/capabilities`,
          { capability: 'project.create_and_lead', reason: 'Leads', idempotencyKey: newKey() },
          'admin',
        )
      ).status,
    ).toBe(201);

    const active = async () =>
      (
        await h.db.pool.query(
          `SELECT (SELECT count(*)::int FROM reviewer_eligibility
                    WHERE user_id = $1 AND revoked_at IS NULL) AS eligibility,
                  (SELECT count(*)::int FROM project_reviewer_assignment
                    WHERE reviewer_user_id = $1 AND removed_at IS NULL) AS reviewer,
                  (SELECT count(*)::int FROM project_report_issuer_grant
                    WHERE issuer_user_id = $1 AND revoked_at IS NULL) AS issuer,
                  (SELECT count(*)::int FROM acceptance_delegation
                    WHERE delegate_user_id = $1 AND revoked_at IS NULL) AS delegate,
                  (SELECT count(*)::int FROM staff_capability_grant
                    WHERE user_id = $1 AND revoked_at IS NULL) AS capability,
                  (SELECT count(*)::int FROM project_team_member
                    WHERE user_id = $1 AND removed_at IS NULL) AS team`,
          [person],
        )
      ).rows[0];
    expect(await active()).toEqual({
      eligibility: 1,
      reviewer: 1,
      issuer: 1,
      delegate: 1,
      capability: 1,
      team: 1,
    });

    expect(
      (await send('post', `/api/staff/${person}/disable`, { reason: 'Leave' }, 'admin')).status,
    ).toBe(200);
    // While disabled nothing is revoked yet (the account itself confers nothing).
    expect((await active())!.issuer).toBe(1);
    const enabled = await send('post', `/api/staff/${person}/enable`, {}, 'admin');
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(await active()).toEqual({
      eligibility: 0,
      reviewer: 0,
      issuer: 0,
      delegate: 0,
      capability: 0,
      team: 1,
    });
    const { rows } = await h.db.pool.query(
      `SELECT action, reason, actor_user_id FROM audit_event
       WHERE (after_values ->> 'userId') = $1 AND reason LIKE 'Account re-enabled%'
       ORDER BY action`,
      [person],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'acceptance_delegation.revoked',
      'project_report_issuer_grant.revoked',
      'project_reviewer_assignment.removed',
      'reviewer_eligibility.revoked',
      'staff_capability_grant.revoked',
    ]);
    expect(new Set(rows.map((r) => r.actor_user_id))).toEqual(new Set([h.users.admin]));
    const { rows: enabledEvent } = await h.db.pool.query(
      `SELECT after_values FROM audit_event WHERE action = 'staff.enabled' AND entity_id = $1`,
      [person],
    );
    expect(enabledEvent[0]!.after_values).toEqual({ status: 'active', revokedGrants: 5 });
  });

  // ---------------------------------------------------------------------------------------------
  // D15 on the existing delegation API
  // ---------------------------------------------------------------------------------------------

  it('D15: acceptance delegation grant and revocation need reasons, kept in history and audit', async () => {
    const person = await addPerson(`d15-${newKey().slice(0, 6)}`, 'Quinn Reason', 'QR');
    const path = projectPath('a', 'acceptance-delegates');
    const before = await snapshot();
    const noReason = await send(
      'post',
      path,
      { delegateUserId: person, idempotencyKey: newKey() },
      'pe',
    );
    expect(noReason.status).toBe(400);
    expect(await snapshot()).toEqual(before);
    const granted = await send(
      'post',
      path,
      { delegateUserId: person, reason: 'Covers acceptance in March', idempotencyKey: newKey() },
      'pe',
    );
    expect(granted.status).toBe(201);
    const grant = granted.body.active.find(
      (d: { delegate: { userId: string } }) => d.delegate.userId === person,
    );
    expect(grant.grantReason).toBe('Covers acceptance in March');
    expect((await send('delete', `${path}/${grant.id}`, {}, 'pe')).status).toBe(400);
    const revoked = await send(
      'delete',
      `${path}/${grant.id}`,
      { reason: 'Back from leave' },
      'pe',
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.history.find((d: { id: string }) => d.id === grant.id).revokeReason).toBe(
      'Back from leave',
    );
    // The database refuses a new grant without a reason too (0002).
    await expect(
      h.db.pool.query(
        `INSERT INTO acceptance_delegation (project_id, delegate_user_id, delegate_name_snapshot,
           granted_by_user_id, granted_by_name_snapshot, grant_idempotency_key, grant_request_hash)
         VALUES ($1, $2, 'Quinn Reason', $3, 'Pat Example', gen_random_uuid(), 'h')`,
        [h.projects.a, person, h.users.pe],
      ),
    ).rejects.toMatchObject({ constraint: 'acceptance_delegation_grant_reason_required' });
  });

  // ---------------------------------------------------------------------------------------------
  // AC4 / D09: concurrent changes resolve deterministically (first commit wins)
  // ---------------------------------------------------------------------------------------------

  describe('AC4 / D09 races', () => {
    let blocker: Client;

    beforeAll(async () => {
      blocker = new Client({ connectionString: databaseUrlForSchema(h.db.schema) });
      await blocker.connect();
    });

    afterEach(async () => {
      await blocker.query('ROLLBACK').catch(() => undefined);
    });

    afterAll(async () => {
      await blocker.end();
    });

    /** Resolves once some backend waits on a row lock while running SQL that mentions `text`. */
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

    async function leadOf(project: 'a' | 'b') {
      const { rows } = await h.db.pool.query<{ lead: string; version: number }>(
        'SELECT lead_project_engineer_user_id AS lead, version FROM project WHERE id = $1',
        [h.projects[project]],
      );
      return rows[0]!;
    }

    const changeLead = async (project: 'a' | 'b', to: string) =>
      h.send(
        'patch',
        `/api/projects/${h.projects[project]}`,
        {
          version: (await leadOf(project)).version,
          leadProjectEngineerId: to,
          reason: 'Handover',
        },
        cookies.admin!,
      );

    it('a lead change that commits first stops the old lead; one that comes later waits and the team row survives (D08)', async () => {
      // Order 1: the lead change holds the project; the old lead's add waits, then is refused.
      const first = await addPerson(`race1-${newKey().slice(0, 6)}`, 'Race One', null);
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE project SET lead_project_engineer_user_id = $2, version = version + 1
         WHERE id = $1`,
        [h.projects.b, h.users.pe],
      );
      const late = addTeam('b', first, 'js');
      await waitForLockWait('FROM project WHERE id');
      await blocker.query('COMMIT');
      const refused = await late;
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(
        (await h.db.pool.query('SELECT 1 FROM project_team_member WHERE user_id = $1', [first]))
          .rows,
      ).toEqual([]);

      // Order 2: the lead's add is in flight (held at its account lock by a concurrent change to
      // that account); the lead change waits for the project, the add commits first and keeps
      // its row and grantor; the lead change then commits too.
      const second = await addPerson(`race2-${newKey().slice(0, 6)}`, 'Race Two', null);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [h.users.pe]);
      const adding = addTeam('b', second, 'pe');
      await waitForLockWait('FROM app_user');
      const changing = changeLead('b', h.users.js);
      await waitForLockWait('FOR UPDATE OF p');
      await blocker.query('COMMIT');
      expect((await adding).status).toBe(201);
      expect((await changing).status).toBe(200);
      expect((await leadOf('b')).lead).toBe(h.users.js);
      const team = projectTeamSchema.parse(
        (await get(projectPath('b', 'team-members'), 'tech')).body,
      );
      expect(team.active.find((m) => m.person.userId === second)).toMatchObject({
        startedBy: { userId: h.users.pe },
      });
    });

    it('an admin role removed first refuses the admin’s write; a disable first refuses the lead’s', async () => {
      const person = await addPerson(`race3-${newKey().slice(0, 6)}`, 'Race Three', null);
      const second = await addPerson(`race4-${newKey().slice(0, 6)}`, 'Race Four', null);
      const admin2 = await addPerson(`adm-${newKey().slice(0, 6)}`, 'Second Admin', null);
      await h.db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin')`, [
        admin2,
      ]);
      const session = await h.app.get(SessionService).create(admin2, 'personal');
      const admin2Cookie = `${SESSION_COOKIE}=${session.token}`;
      const before = await snapshot();
      // As staff.setRoles does: lock the account, change its roles, commit.
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [admin2]);
      await blocker.query(`DELETE FROM role_assignment WHERE user_id = $1`, [admin2]);
      const late = send(
        'post',
        projectPath('a', 'team-members'),
        { userId: person, reason: 'Supporting', idempotencyKey: newKey() },
        admin2Cookie,
      );
      await waitForLockWait('FROM app_user');
      await blocker.query('COMMIT');
      expect((await late).status).toBe(403);
      expect(await snapshot()).toEqual(before);

      // As users.disable does: the lead's account is disabled while their grant is in flight.
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [h.users.pe]);
      const disabled = grantIssuer('a', second, 'pe');
      await waitForLockWait('FROM app_user');
      await blocker.query('COMMIT');
      // It was already past sign-in checks and waiting on the account lock: refused under it.
      expect((await disabled).status).toBe(403);
      expect(await snapshot()).toEqual(before);
      await h.db.pool.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [h.users.pe]);
      cookies.pe = await h.cookie('pe');
    });

    /** A submitted program on a fresh hole of B. */
    async function submittedProgram() {
      const holeId = (
        await h.db.pool.query<{ id: string }>(
          'INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id',
          [h.projects.b, `TH-${newKey().slice(0, 8)}`],
        )
      ).rows[0]!.id;
      await h.bucket({ project: 'b', hole: holeId });
      const created = await h.send(
        'post',
        '/api/lab-programs',
        {
          projectId: h.projects.b,
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
      return labProgramSchema.parse(submitted.body);
    }

    it('D09: a lead change and a priority change by the lead resolve in commit order', async () => {
      await changeLead('b', h.users.js);
      const program = await submittedProgram();
      const priority = (to: 'normal' | 'urgent', version: number) =>
        h.send(
          'patch',
          `/api/lab-programs/${program.id}/priority`,
          { priority: to, version, idempotencyKey: newKey() },
          cookies.js!,
        );
      // Lead change first: js's change waits for the project, then is refused.
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE project SET lead_project_engineer_user_id = $2, version = version + 1
         WHERE id = $1`,
        [h.projects.b, h.users.pe],
      );
      const late = priority('urgent', program.version);
      await waitForLockWait('FROM project WHERE id');
      await blocker.query('COMMIT');
      expect((await late).status).toBe(403);
      const { rows: unchanged } = await h.db.pool.query(
        'SELECT priority FROM lab_program WHERE id = $1',
        [program.id],
      );
      expect(unchanged[0]).toEqual({ priority: 'normal' });

      // Priority change first: it holds the project while it finishes; the lead change waits.
      await changeLead('b', h.users.js);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [h.users.js]);
      const early = priority('urgent', program.version);
      await waitForLockWait('FROM app_user');
      const changing = changeLead('b', h.users.pe);
      await waitForLockWait('FOR UPDATE OF p');
      await blocker.query('COMMIT');
      expect((await early).status, JSON.stringify((await early).body)).toBe(200);
      expect((await changing).status).toBe(200);
      const { rows: changed } = await h.db.pool.query(
        'SELECT priority FROM lab_program WHERE id = $1',
        [program.id],
      );
      expect(changed[0]).toEqual({ priority: 'urgent' });
    });

    it('D09: a lead change that commits first stops the old lead’s disposal approval', async () => {
      await changeLead('b', h.users.js);
      const unit = await h.bucket({
        project: 'b',
        hole: (
          await h.db.pool.query<{ id: string }>(
            'INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id',
            [h.projects.b, `TH-${newKey().slice(0, 8)}`],
          )
        ).rows[0]!.id,
        receivedDate: '2020-01-02',
      });
      const approve = () =>
        h.send(
          'post',
          '/api/disposal/approvals',
          { unitIds: [unit.id], idempotencyKey: newKey() },
          cookies.js!,
        );
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE project SET lead_project_engineer_user_id = $2, version = version + 1
         WHERE id = $1`,
        [h.projects.b, h.users.pe],
      );
      const late = approve();
      await waitForLockWait('ORDER BY p.id FOR SHARE');
      await blocker.query('COMMIT');
      expect((await late).status).toBe(403);
      expect(
        (
          await h.db.pool.query('SELECT 1 FROM disposal_approval WHERE storage_unit_id = $1', [
            unit.id,
          ])
        ).rows,
      ).toEqual([]);
      // Back to js: the same approval now succeeds.
      await changeLead('b', h.users.js);
      const ok = await approve();
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('an eligibility revocation that commits first refuses the reviewer assignment', async () => {
      const person = await addPerson(`race5-${newKey().slice(0, 6)}`, 'Race Five', null);
      const grants = staffGrantsSchema.parse((await grantEligibility(person)).body);
      const eligibilityId = grants.reviewerEligibility.active[0]!.id;
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE reviewer_eligibility SET revoked_at = clock_timestamp(), revoked_by_user_id = $2,
                revoked_by_name_snapshot = 'Admin Example', revoke_reason = 'Lapsed'
         WHERE id = $1`,
        [eligibilityId, h.users.admin],
      );
      const late = assignReviewer('a', person, 'pe');
      await waitForLockWait('FROM reviewer_eligibility');
      await blocker.query('COMMIT');
      const refused = await late;
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('not_eligible');
    });
  });
});
