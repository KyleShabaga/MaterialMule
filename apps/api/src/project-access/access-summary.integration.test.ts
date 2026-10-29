import {
  accessSummarySchema,
  profileResponseSchema,
  projectCapabilitiesSchema,
  staffGrantsSchema,
  staffMemberSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-AO06 staff administration and My access (card AC1–AC4). Real PostgreSQL, direct API calls.
// Fictional data only: DEMO-2601 (A) and DEMO-2602 (B), both led by Pat Example (`pe`); Jordan
// Smith (`js`) supports A, reviews it and issues there, and accepts on B; Terry Tech (`tech`)
// supports B only.
describe.runIf(testDatabaseUrl)('staff administration and My access (MM-AO06)', () => {
  let h: LabHarness;
  type As = PersonKey | 'lab';

  const put = async (path: string, body: unknown, as: As) =>
    h
      .http()
      .put(path)
      .set('Cookie', await h.cookie(as as PersonKey))
      .set(CSRF_HEADER, '1')
      .send(body as object);
  const del = async (path: string, body: unknown, as: As) =>
    h
      .http()
      .delete(path)
      .set('Cookie', await h.cookie(as as PersonKey))
      .set(CSRF_HEADER, '1')
      .send(body as object);
  const project = (key: 'a' | 'b', rest: string) => `/api/projects/${h.projects[key]}/${rest}`;

  async function summary(path: string, as: As) {
    const response = await h.get(path, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return accessSummarySchema.parse(response.body);
  }

  async function capabilities(key: 'a' | 'b', as: As) {
    const response = await h.get(project(key, 'capabilities'), as);
    expect(response.status).toBe(200);
    return projectCapabilitiesSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    const ok = (response: { status: number; body: unknown }) =>
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    const reason = 'Set up for the fictional cast';
    ok(
      await h.send(
        'post',
        project('a', 'team-members'),
        { userId: h.users.js, reason, idempotencyKey: newKey() },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        project('b', 'team-members'),
        { userId: h.users.tech, reason, idempotencyKey: newKey() },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        `/api/staff/${h.users.js}/reviewer-eligibility`,
        {
          scopeCode: 'concrete_field',
          reason: 'Qualified field reviewer',
          idempotencyKey: newKey(),
        },
        'admin',
      ),
    );
    ok(
      await h.send(
        'post',
        project('a', 'reviewer-assignments'),
        {
          reviewerUserId: h.users.js,
          scopeCode: 'concrete_field',
          reason: 'Reviews field reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        project('a', 'report-issuers'),
        {
          issuerUserId: h.users.js,
          scopeCode: 'concrete_strength',
          reason: 'Signs strength reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        project('b', 'acceptance-delegates'),
        { delegateUserId: h.users.js, reason: 'Covers acceptance', idempotencyKey: newKey() },
        'pe',
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC3: My access lists only the signed-in person’s current roles, grants and responsibilities', async () => {
    const mine = await summary('/api/me/access', 'js');
    expect(mine.userId).toBe(h.users.js);
    expect(mine.reviewerEligibility.map((g) => g.scope.code)).toEqual(['concrete_field']);
    expect(mine.projectsTotal).toBe(2);
    const a = mine.projects.find((p) => p.project.id === h.projects.a)!;
    expect(a).toMatchObject({
      lead: false,
      teamMember: { reason: 'Set up for the fictional cast' },
      reviewer: [{ scope: { code: 'concrete_field' }, effective: true, blockedReason: null }],
      acceptanceDelegate: null,
      reportIssuer: [{ scope: { code: 'concrete_strength' }, effective: true, expiresAt: null }],
      pendingLeadNomination: false,
    });
    expect(a.teamMember!.by.userId).toBe(h.users.pe);
    const b = mine.projects.find((p) => p.project.id === h.projects.b)!;
    expect(b).toMatchObject({
      teamMember: null,
      reviewer: [],
      reportIssuer: [],
      acceptanceDelegate: { reason: 'Covers acceptance' },
    });

    // Someone else's rows never appear: tech supports B only.
    const tech = await summary('/api/me/access', 'tech');
    expect(tech.projects.map((p) => p.project.id)).toEqual([h.projects.b]);
    expect(tech.projects[0]).toMatchObject({ reviewer: [], acceptanceDelegate: null });
    expect(tech.reviewerEligibility).toEqual([]);

    // The lead's summary marks lead on both.
    const pe = await summary('/api/me/access', 'pe');
    expect(pe.projects.every((p) => p.lead)).toBe(true);

    // The shared LAB account has no personal access; anonymous callers none at all.
    const lab = await h.get('/api/me/access', 'lab');
    expect(lab.status).toBe(403);
    expect(lab.body.code).toBe('forbidden');
    expect((await h.http().get('/api/me/access')).status).toBe(401);
  });

  it('an admin reads anyone’s summary read-only; nobody else can', async () => {
    const viewed = await summary(`/api/staff/${h.users.js}/access`, 'admin');
    expect(viewed).toEqual(await summary('/api/me/access', 'js'));
    for (const caller of ['tech', 'pe', 'lm', 'lab'] as const) {
      expect((await h.get(`/api/staff/${h.users.js}/access`, caller)).status).toBe(403);
    }
    expect((await h.get('/api/staff/not-an-id/access', 'admin')).status).toBe(404);
  });

  it('ineffective grants are listed with why; revoked and ended ones disappear', async () => {
    // Written directly with a past expiry, as time passing would leave it (B, field reports).
    await h.db.pool.query(
      `INSERT INTO project_report_issuer_grant (project_id, issuer_user_id, issuer_name_snapshot,
         report_scope_code, granted_by_user_id, granted_by_name_snapshot, grant_reason, granted_at,
         expires_at, grant_idempotency_key, grant_request_hash)
       VALUES ($1, $2, 'Jordan Smith', 'concrete_field', $3, 'Pat Example', 'Short cover',
               now() - interval '2 days', now() - interval '1 day', gen_random_uuid(), 'h')`,
      [h.projects.b, h.users.js, h.users.pe],
    );
    const grants = staffGrantsSchema.parse(
      (await h.get(`/api/staff/${h.users.js}/grants`, 'admin')).body,
    );
    const eligibility = grants.reviewerEligibility.active[0]!;
    expect(
      (
        await del(
          `/api/staff/${h.users.js}/reviewer-eligibility/${eligibility.id}`,
          { reason: 'Qualification lapsed' },
          'admin',
        )
      ).status,
    ).toBe(200);
    const mine = await summary('/api/me/access', 'js');
    expect(mine.reviewerEligibility).toEqual([]);
    const a = mine.projects.find((p) => p.project.id === h.projects.a)!;
    expect(a.reviewer).toMatchObject([{ effective: false, blockedReason: 'eligibility_revoked' }]);
    expect(a.reportIssuer).toMatchObject([{ effective: true, blockedReason: null }]);
    const b = mine.projects.find((p) => p.project.id === h.projects.b)!;
    expect(b.reportIssuer).toMatchObject([
      { scope: { code: 'concrete_field' }, effective: false, blockedReason: 'expired' },
    ]);
  });

  it('AC2: a capability change is audited and the next request reflects it', async () => {
    const create = (as: As, body: Record<string, unknown>) =>
      h.send(
        'post',
        '/api/projects',
        {
          projectNumber: `AO6-${newKey().slice(0, 8)}`,
          name: 'Fictional works',
          client: 'Example Client',
          ...body,
        },
        as,
      );
    expect((await create('tech', { appointSelfAsLead: true })).status).toBe(403);
    const granted = await h.send(
      'post',
      `/api/staff/${h.users.tech}/capabilities`,
      {
        capability: 'project.create_and_lead',
        reason: 'Leads small jobs',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    expect(granted.status).toBe(201);
    expect((await summary('/api/me/access', 'tech')).capabilities).toMatchObject([
      { capability: 'project.create_and_lead', startReason: 'Leads small jobs' },
    ]);
    expect((await create('tech', { appointSelfAsLead: true })).status).toBe(201);

    const grantId = staffGrantsSchema.parse(granted.body).capabilities.active[0]!.id;
    expect(
      (
        await del(
          `/api/staff/${h.users.tech}/capabilities/${grantId}`,
          { reason: 'Back to supporting' },
          'admin',
        )
      ).status,
    ).toBe(200);
    expect((await summary('/api/me/access', 'tech')).capabilities).toEqual([]);
    expect((await create('tech', { appointSelfAsLead: true })).status).toBe(403);
    const { rows } = await h.db.pool.query(
      `SELECT action, reason, actor_user_id FROM audit_event
       WHERE entity_id = $1 AND action LIKE 'staff_capability_grant.%' ORDER BY occurred_at`,
      [grantId],
    );
    expect(rows).toMatchObject([
      { action: 'staff_capability_grant.granted', reason: 'Leads small jobs' },
      { action: 'staff_capability_grant.revoked', reason: 'Back to supporting' },
    ]);
  });

  it('AC1: a job-title override needs a reason, is audited, and changes no access', async () => {
    const path = `/api/staff/${h.users.js}/job-title-override`;
    const beforeCaps = await capabilities('a', 'js');
    const beforeGrants = (await h.get('/api/me/grants', 'js')).body;
    const beforeAccess = await summary('/api/me/access', 'js');

    expect((await put(path, { jobTitleOverride: 'Senior Engineer' }, 'admin')).status).toBe(400);
    expect(
      (await put(path, { jobTitleOverride: 'Senior Engineer', reason: ' ' }, 'admin')).status,
    ).toBe(400);
    for (const caller of ['tech', 'pe', 'lm', 'js'] as const) {
      expect(
        (await put(path, { jobTitleOverride: 'Principal', reason: 'Promotion' }, caller)).status,
      ).toBe(403);
    }
    const lab = await put(
      `/api/staff/${h.users.lab}/job-title-override`,
      { jobTitleOverride: 'Station', reason: 'Label' },
      'admin',
    );
    expect(lab.status).toBe(422);
    expect(lab.body.code).toBe('not_personal_account');

    await h.db.pool.query(`UPDATE app_user SET job_title = 'Field Technician' WHERE id = $1`, [
      h.users.js,
    ]);
    const set = await put(
      path,
      { jobTitleOverride: '  Senior Engineer  ', reason: 'Title per firm records' },
      'admin',
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(staffMemberSchema.parse(set.body)).toMatchObject({
      jobTitle: 'Field Technician',
      jobTitleOverride: 'Senior Engineer',
      jobTitleOverrideSetBy: expect.any(String),
      effectiveJobTitle: { value: 'Senior Engineer', source: 'override' },
    });
    // Same value again: nothing new.
    expect(
      (await put(path, { jobTitleOverride: 'Senior Engineer', reason: 'Again' }, 'admin')).status,
    ).toBe(200);

    const profile = profileResponseSchema.parse((await h.get('/api/me/profile', 'js')).body);
    expect(profile).toMatchObject({
      jobTitle: 'Field Technician',
      jobTitleOverride: 'Senior Engineer',
      effectiveJobTitle: { value: 'Senior Engineer', source: 'override' },
    });

    // Nothing about access changed.
    expect(await capabilities('a', 'js')).toEqual(beforeCaps);
    expect((await h.get('/api/me/grants', 'js')).body).toEqual(beforeGrants);
    const afterAccess = await summary('/api/me/access', 'js');
    expect({ ...afterAccess, effectiveJobTitle: null }).toEqual({
      ...beforeAccess,
      effectiveJobTitle: null,
    });
    expect(afterAccess.effectiveJobTitle).toEqual({ value: 'Senior Engineer', source: 'override' });

    const cleared = await put(
      path,
      { jobTitleOverride: null, reason: 'Use Microsoft title' },
      'admin',
    );
    expect(staffMemberSchema.parse(cleared.body)).toMatchObject({
      jobTitleOverride: null,
      jobTitleOverrideSetBy: null,
      effectiveJobTitle: { value: 'Field Technician', source: 'microsoft' },
    });
    const { rows } = await h.db.pool.query(
      `SELECT action, reason, before_values, after_values FROM audit_event
       WHERE entity_id = $1 AND action LIKE 'staff.job_title_override_%' ORDER BY occurred_at`,
      [h.users.js],
    );
    expect(rows).toMatchObject([
      {
        action: 'staff.job_title_override_set',
        reason: 'Title per firm records',
        before_values: { jobTitleOverride: null },
        after_values: { jobTitleOverride: 'Senior Engineer' },
      },
      {
        action: 'staff.job_title_override_cleared',
        reason: 'Use Microsoft title',
        after_values: { jobTitleOverride: null },
      },
    ]);
  });
});
