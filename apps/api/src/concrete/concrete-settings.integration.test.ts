import {
  concreteProjectSettingsSchema,
  concreteSettingsVersionConflictResponseSchema,
  projectCapabilitiesSchema,
  projectConcreteLabManagersSchema,
  projectReviewersSchema,
  staffGrantsSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, type AuthUser } from '../auth/policy.js';
import { withTransaction } from '../db/transaction.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { revokeTechnicalGrants } from '../project-access/grant-tables.js';
import { findProject, projectContext } from '../project-access/project-access.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// MM-V2-C02: per-project concrete settings, the concrete Lab Manager grant (D13) and the concrete
// review / HOLD authority their loaders feed (card AC1, AC3, AC4; test plan T1–T3). Real
// PostgreSQL, direct API calls. Fictional data only: DEMO-2601 (A, led by Pat Example `pe`) and
// DEMO-2602 (B, led here by Jordan Smith `js`), plus invented reviewer and Lab Manager people.
describe.runIf(testDatabaseUrl)('concrete settings and authority (MM-V2-C02)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  const people: Record<string, string> = {};

  type Caller = PersonKey | 'lab' | 'anonymous' | 'rev' | 'lm2';

  const path = (project: 'a' | 'b', rest: string) => `/api/projects/${h.projects[project]}/${rest}`;
  const get = async (url: string, as: Caller) => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const send = async (
    method: 'post' | 'patch' | 'delete',
    url: string,
    body: unknown,
    as: Caller,
  ) => {
    const req = h.http()[method](url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };
  const saveSettings = (body: Record<string, unknown>, as: Caller, project: 'a' | 'b' = 'a') =>
    send('patch', path(project, 'concrete-settings'), body, as);
  const grantLm = (
    labManagerUserId: string,
    as: Caller,
    key = newKey(),
    project: 'a' | 'b' = 'a',
  ) =>
    send(
      'post',
      path(project, 'concrete-lab-managers'),
      { labManagerUserId, reason: 'Runs failed-specimen holds here', idempotencyKey: key },
      as,
    );

  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_project_settings) AS settings,
              (SELECT coalesce(max(version), 0)::int FROM concrete_project_settings) AS version,
              (SELECT count(*)::int FROM project_concrete_lab_manager_grant) AS grants,
              (SELECT count(*)::int FROM project_concrete_lab_manager_grant
               WHERE revoked_at IS NOT NULL) AS revoked,
              (SELECT count(*)::int FROM audit_event) AS audit`,
    );
    return rows[0];
  }

  /** The signed-in principal for a person, with roles as they stand. */
  async function principal(userId: string): Promise<AuthUser> {
    const { rows } = await h.db.pool.query<{
      account_type: AuthUser['accountType'];
      status: AuthUser['status'];
      display_name: string;
      roles: AuthUser['roles'];
    }>(
      `SELECT account_type, status, display_name,
              COALESCE((SELECT array_agg(role) FROM role_assignment WHERE user_id = u.id), '{}')
                AS roles
       FROM app_user u WHERE id = $1`,
      [userId],
    );
    const row = rows[0]!;
    return {
      userId,
      sessionId: '',
      accountType: row.account_type,
      status: row.status,
      roles: row.roles,
      displayName: row.display_name,
      initials: null,
    };
  }

  /** `can()` with the project facts loaded from the database, as every concrete route will. */
  async function canOnA(
    userId: string,
    permission: 'concrete_hold.manage' | 'concrete.review',
    scope?: string,
  ) {
    const project = (await findProject(h.db.pool, h.projects.a))!;
    const context = await projectContext(h.db.pool, project, undefined, scope, {
      concreteLabManagers: permission === 'concrete_hold.manage',
    });
    return can(await principal(userId), permission, context);
  }

  async function addPerson(
    key: 'rev' | 'lm2',
    name: string,
    initials: string,
    roles: string[] = [],
  ) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', 'active') RETURNING id`,
      [name, initials],
    );
    for (const role of roles) {
      await h.db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    people[key] = rows[0]!.id;
    const session = await h.app.get(SessionService).create(rows[0]!.id, 'personal');
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
  }

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab', 'disabled'] as const) {
      people[key] = h.users[key];
      cookies[key] = await h.cookie(key);
    }
    await addPerson('rev', 'Riley Reviewer', 'RR');
    await addPerson('lm2', 'Morgan Manager', 'MM', ['lab_manager']);
    await h.db.pool.query('UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1', [
      h.projects.b,
      h.users.js,
    ]);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  describe('concrete settings', () => {
    it('reads the confirmed defaults before the first save; every active session may read', async () => {
      for (const caller of ['lab', 'tech', 'lm', 'pe', 'admin'] as const) {
        const response = await get(path('a', 'concrete-settings'), caller);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const settings = concreteProjectSettingsSchema.parse(response.body);
        expect(settings).toMatchObject({
          projectId: h.projects.a,
          defaultSpecimenAges: [7, 28, 28, 'HOLD'],
          holdDurationDays: 56,
          includeMachineInfo: null,
          version: 0,
          updatedAt: null,
          updatedBy: null,
          history: [],
          historyTotal: 0,
          canEdit: caller === 'pe' || caller === 'admin',
        });
      }
      expect((await get(path('a', 'concrete-settings'), 'anonymous')).status).toBe(401);
      expect((await get('/api/projects/not-a-uuid/concrete-settings', 'pe')).status).toBe(404);
    });

    it('AC4: only the project’s lead or an admin save; refusals come before the body and write nothing', async () => {
      const before = await counts();
      const expectations: [Caller, number, string][] = [
        ['anonymous', 401, 'unauthenticated'],
        ['disabled', 401, 'unauthenticated'],
        ['lab', 403, 'forbidden'],
        ['tech', 403, 'forbidden'],
        ['lm', 403, 'forbidden'],
        // js leads B, not A: unrelated project authority.
        ['js', 403, 'forbidden'],
        ['rev', 403, 'forbidden'],
      ];
      for (const [caller, status, code] of expectations) {
        for (const body of [
          { version: 0, holdDurationDays: 90 },
          { version: 'x', bogus: true },
        ]) {
          const response = await saveSettings(body, caller);
          expect(response.status, `${caller}: ${JSON.stringify(response.body)}`).toBe(status);
          expect(response.body.code).toBe(code);
        }
      }
      // An unknown project: 404 for someone who could edit projects, 403 otherwise.
      const missing = '/api/projects/00000000-0000-4000-8000-00000000dead/concrete-settings';
      expect((await send('patch', missing, { version: 0 }, 'admin')).status).toBe(404);
      expect((await send('patch', missing, { version: 0 }, 'tech')).status).toBe(403);
      expect(await counts()).toEqual(before);
    });

    it('validates the body (400) and writes nothing', async () => {
      const before = await counts();
      for (const body of [
        {},
        { version: -1 },
        { version: 0, defaultSpecimenAges: [] },
        { version: 0, defaultSpecimenAges: [0] },
        { version: 0, defaultSpecimenAges: [7.5] },
        { version: 0, defaultSpecimenAges: ['hold'] },
        { version: 0, defaultSpecimenAges: Array.from({ length: 27 }, () => 28) },
        { version: 0, holdDurationDays: 0 },
        { version: 0, holdDurationDays: 1000 },
        { version: 0, includeMachineInfo: 'yes' },
        { version: 0, reviewers: ['someone'] },
      ]) {
        const response = await saveSettings(body, 'pe');
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.code).toBe('validation_failed');
      }
      expect(await counts()).toEqual(before);
    });

    it('saves with version checks and audit history; a stale version is 409 with nothing written', async () => {
      const first = await saveSettings(
        { version: 0, holdDurationDays: 90, reason: 'Client asked for a longer HOLD' },
        'pe',
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const saved = concreteProjectSettingsSchema.parse(first.body);
      expect(saved).toMatchObject({
        version: 1,
        holdDurationDays: 90,
        defaultSpecimenAges: [7, 28, 28, 'HOLD'],
        includeMachineInfo: null,
        updatedBy: { userId: people.pe },
        historyTotal: 1,
      });
      expect(saved.history[0]).toMatchObject({
        changedBy: { userId: people.pe },
        reason: 'Client asked for a longer HOLD',
        before: { holdDurationDays: 56 },
        after: { holdDurationDays: 90 },
      });

      // A second "first save" (version 0) and any other stale version are refused.
      const before = await counts();
      for (const version of [0, 2]) {
        const stale = await saveSettings({ version, holdDurationDays: 30 }, 'admin');
        expect(stale.status).toBe(409);
        const conflict = concreteSettingsVersionConflictResponseSchema.parse(stale.body);
        expect(conflict.current).toMatchObject({ version: 1, holdDurationDays: 90 });
      }
      expect(await counts()).toEqual(before);

      // An admin saves with the current version; only the changed fields are audited.
      const second = await saveSettings(
        {
          version: 1,
          holdDurationDays: 90,
          defaultSpecimenAges: [3, 7, 28, 'HOLD'],
          includeMachineInfo: true,
        },
        'admin',
      );
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const after = concreteProjectSettingsSchema.parse(second.body);
      expect(after).toMatchObject({
        version: 2,
        defaultSpecimenAges: [3, 7, 28, 'HOLD'],
        includeMachineInfo: true,
        updatedBy: { userId: people.admin },
        historyTotal: 2,
      });
      expect(after.history[0]).toMatchObject({
        reason: null,
        before: { defaultSpecimenAges: [7, 28, 28, 'HOLD'], includeMachineInfo: null },
        after: { defaultSpecimenAges: [3, 7, 28, 'HOLD'], includeMachineInfo: true },
      });
      expect(Object.keys(after.history[0]!.after).sort()).toEqual([
        'defaultSpecimenAges',
        'includeMachineInfo',
      ]);

      // A save that changes nothing keeps the version and writes no event.
      const unchanged = await counts();
      const noop = await saveSettings({ version: 2, holdDurationDays: 90 }, 'pe');
      expect(noop.status).toBe(200);
      expect(noop.body.version).toBe(2);
      expect(await counts()).toEqual(unchanged);

      // Back to "not chosen".
      const cleared = await saveSettings({ version: 2, includeMachineInfo: null }, 'pe');
      expect(cleared.body).toMatchObject({ version: 3, includeMachineInfo: null });

      // Another project's settings are separate.
      const other = await get(path('b', 'concrete-settings'), 'js');
      expect(other.body).toMatchObject({ version: 0, holdDurationDays: 56, canEdit: true });
    });

    it('AC3: saving defaults changes no existing concrete report, set or specimen', async () => {
      const { rows: report } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)
         RETURNING id`,
        [h.projects.a, people.pe],
      );
      const { rows: set } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO concrete_specimen_set (project_id, field_report_id) VALUES ($1, $2)
         RETURNING id`,
        [h.projects.a, report[0]!.id],
      );
      await h.db.pool.query(
        `INSERT INTO concrete_specimen (project_id, set_id, letter, assigned_age)
         VALUES ($1, $2, 'A', '7'), ($1, $2, 'B', '28'), ($1, $2, 'C', '28'), ($1, $2, 'D', 'HOLD')`,
        [h.projects.a, set[0]!.id],
      );
      const snapshot = async () =>
        (
          await h.db.pool.query(
            `SELECT (SELECT json_agg(r ORDER BY r.id) FROM concrete_field_report r) AS reports,
                    (SELECT json_agg(s ORDER BY s.id) FROM concrete_specimen_set s) AS sets,
                    (SELECT json_agg(c ORDER BY c.id) FROM concrete_specimen c) AS specimens`,
          )
        ).rows[0];
      const before = await snapshot();
      const current = (await get(path('a', 'concrete-settings'), 'pe')).body.version as number;
      const response = await saveSettings(
        { version: current, defaultSpecimenAges: [7, 7, 28, 56], holdDurationDays: 120 },
        'pe',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await snapshot()).toEqual(before);
    });

    it('D09: a lead removed by a change that committed first can no longer save', async () => {
      const current = (await get(path('a', 'concrete-settings'), 'pe')).body.version as number;
      await h.db.pool.query(
        'UPDATE project SET lead_project_engineer_user_id = NULL WHERE id = $1',
        [h.projects.a],
      );
      try {
        const before = await counts();
        const response = await saveSettings({ version: current, holdDurationDays: 45 }, 'pe');
        expect(response.status).toBe(403);
        expect(await counts()).toEqual(before);
        // An admin still can, with no lead (settings are not lead-only).
        const admin = await saveSettings({ version: current, holdDurationDays: 45 }, 'admin');
        expect(admin.status).toBe(200);
        expect(admin.body.canEdit).toBe(true);
      } finally {
        await h.db.pool.query(
          'UPDATE project SET lead_project_engineer_user_id = $2 WHERE id = $1',
          [h.projects.a, people.pe],
        );
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Concrete Lab Manager grant (D13)
  // ---------------------------------------------------------------------------------------------

  describe('concrete Lab Manager grant', () => {
    it('only the lead or an admin grant it; refusals write nothing', async () => {
      const before = await counts();
      const expectations: [Caller, number, string][] = [
        ['anonymous', 401, 'unauthenticated'],
        ['disabled', 401, 'unauthenticated'],
        ['lab', 403, 'forbidden'],
        ['tech', 403, 'forbidden'],
        ['lm', 403, 'forbidden'],
        ['lm2', 403, 'forbidden'],
        ['js', 403, 'forbidden'],
        ['rev', 403, 'forbidden'],
      ];
      for (const [caller, status, code] of expectations) {
        const response = await grantLm(people.lm!, caller);
        expect(response.status, `${caller}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(response.body.code).toBe(code);
        // 403 before 400: an invalid body from someone who can't grant is still 403.
        if (status === 403) {
          expect((await send('post', path('a', 'concrete-lab-managers'), {}, caller)).status).toBe(
            403,
          );
        }
      }
      expect((await get(path('a', 'concrete-lab-managers'), 'lab')).status).toBe(403);
      expect(await counts()).toEqual(before);
    });

    it('refuses a recipient without the Lab Manager role, LAB, a missing reason and a duplicate', async () => {
      const before = await counts();
      const notLm = await grantLm(people.tech!, 'pe');
      expect(notLm.status).toBe(422);
      expect(notLm.body.code).toBe('not_lab_manager');
      const lab = await grantLm(people.lab!, 'pe');
      expect(lab.status).toBe(422);
      expect(lab.body.code).toBe('invalid_recipient');
      const noReason = await send(
        'post',
        path('a', 'concrete-lab-managers'),
        { labManagerUserId: people.lm, reason: ' ', idempotencyKey: newKey() },
        'pe',
      );
      expect(noReason.status).toBe(400);
      expect(await counts()).toEqual(before);
    });

    it('AC1: concrete_hold.manage needs the grant and the role; revoking removes it', async () => {
      expect(await canOnA(people.lm!, 'concrete_hold.manage')).toBe(false);
      expect(await canOnA(people.pe!, 'concrete_hold.manage')).toBe(true);

      const key = newKey();
      const granted = await grantLm(people.lm!, 'pe', key);
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      const list = projectConcreteLabManagersSchema.parse(granted.body);
      expect(list.canManage).toBe(true);
      expect(list.active).toHaveLength(1);
      expect(list.active[0]).toMatchObject({
        labManager: { userId: people.lm },
        startedBy: { userId: people.pe },
        startReason: 'Runs failed-specimen holds here',
        effective: true,
        blockedReason: null,
      });
      expect(await canOnA(people.lm!, 'concrete_hold.manage')).toBe(true);
      // Only on this project.
      const b = (await findProject(h.db.pool, h.projects.b))!;
      expect(
        can(
          await principal(people.lm!),
          'concrete_hold.manage',
          await projectContext(h.db.pool, b, undefined, undefined, { concreteLabManagers: true }),
        ),
      ).toBe(false);

      // An exact retry returns the list without a second row; a reused key for another intent is 409.
      const before = await counts();
      const retry = await grantLm(people.lm!, 'pe', key);
      expect(retry.status).toBe(201);
      expect(await counts()).toEqual(before);
      const reused = await grantLm(people.lm2!, 'pe', key);
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('idempotency_key_reused');
      const duplicate = await grantLm(people.lm!, 'admin');
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.code).toBe('already_assigned');

      // The role alone, or the grant alone, is not enough.
      await h.db.pool.query(
        `DELETE FROM role_assignment WHERE user_id = $1 AND role = 'lab_manager'`,
        [people.lm],
      );
      try {
        expect(await canOnA(people.lm!, 'concrete_hold.manage')).toBe(false);
        const blocked = projectConcreteLabManagersSchema.parse(
          (await get(path('a', 'concrete-lab-managers'), 'pe')).body,
        );
        expect(blocked.active[0]).toMatchObject({
          effective: false,
          blockedReason: 'not_lab_manager',
        });
      } finally {
        await h.db.pool.query(
          `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
          [people.lm],
        );
      }
      expect(await canOnA(people.lm2!, 'concrete_hold.manage')).toBe(false);

      // Revoking needs a reason and only the lead or an admin; then the authority is gone.
      const id = list.active[0]!.id;
      const revokePath = path('a', `concrete-lab-managers/${id}`);
      expect((await send('delete', revokePath, { reason: 'x' }, 'lm')).status).toBe(403);
      expect((await send('delete', revokePath, {}, 'pe')).status).toBe(400);
      expect(
        (
          await send(
            'delete',
            path('b', `concrete-lab-managers/${id}`),
            { reason: 'Wrong project' },
            'js',
          )
        ).status,
      ).toBe(404);
      const revoked = await send(
        'delete',
        revokePath,
        { reason: 'Hold work moved to Morgan' },
        'pe',
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      const after = projectConcreteLabManagersSchema.parse(revoked.body);
      expect(after.active).toEqual([]);
      expect(after.history[0]).toMatchObject({
        endedBy: { userId: people.pe },
        endReason: 'Hold work moved to Morgan',
        effective: false,
      });
      expect(await canOnA(people.lm!, 'concrete_hold.manage')).toBe(false);
      // Revoking again changes nothing.
      const unchanged = await counts();
      expect((await send('delete', revokePath, { reason: 'Again' }, 'pe')).status).toBe(200);
      expect(await counts()).toEqual(unchanged);

      const { rows: audit } = await h.db.pool.query<{ action: string; reason: string }>(
        `SELECT action, reason FROM audit_event WHERE entity_type = 'project_concrete_lab_manager_grant'
         ORDER BY occurred_at, action`,
      );
      expect(audit).toEqual([
        {
          action: 'project_concrete_lab_manager_grant.granted',
          reason: 'Runs failed-specimen holds here',
        },
        {
          action: 'project_concrete_lab_manager_grant.revoked',
          reason: 'Hold work moved to Morgan',
        },
      ]);
    });

    it('an admin grants too; D08 re-enable revokes it with the other technical grants', async () => {
      const granted = await grantLm(people.lm2!, 'admin');
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      expect(await canOnA(people.lm2!, 'concrete_hold.manage')).toBe(true);
      const admin = await principal(people.admin!);
      await withTransaction(h.db.pool, async (client) => {
        await client.query('SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE', [people.lm2]);
        const count = await revokeTechnicalGrants(
          client,
          people.lm2!,
          { userId: admin.userId, initials: null, displayName: admin.displayName },
          {
            userId: admin.userId,
            accountType: 'personal',
            initials: null,
            name: admin.displayName,
          },
        );
        expect(count).toBe(1);
      });
      expect(await canOnA(people.lm2!, 'concrete_hold.manage')).toBe(false);
    });

    it('the capability list adds no settings or grant action: grant authority is project.edit', async () => {
      for (const [caller, allowed] of [
        ['pe', true],
        ['admin', true],
        ['lm', false],
        ['tech', false],
        ['js', false],
      ] as const) {
        const caps = projectCapabilitiesSchema.parse(
          (await get(path('a', 'capabilities'), caller)).body,
        );
        const entry = caps.capabilities.find((c) => c.action === 'project.edit');
        expect(entry?.allowed, caller).toBe(allowed);
        // Only actions with a route are listed (AO08 Q2): C03 added the mix actions; the
        // review and HOLD actions wait for their cards.
        expect(
          caps.capabilities.map((c) => c.action).filter((a) => a.startsWith('concrete')),
        ).toEqual(['concrete_mix.manage', 'concrete_mix.approve']);
        expect(caps.capabilities.map((c) => c.action)).not.toContain('concrete_hold.manage');
        expect(caps.capabilities.map((c) => c.action)).not.toContain('concrete.review');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Concrete review through MISC-08 (no second reviewer list)
  // ---------------------------------------------------------------------------------------------

  it('AC1: concrete.review needs an assignment WITH the lead’s approval and eligibility', async () => {
    const scope = 'concrete_field';
    expect(await canOnA(people.pe!, 'concrete.review', scope)).toBe(true);
    expect(await canOnA(people.rev!, 'concrete.review', scope)).toBe(false);

    const eligible = await send(
      'post',
      `/api/staff/${people.rev}/reviewer-eligibility`,
      { scopeCode: scope, reason: 'Qualified field reviewer', idempotencyKey: newKey() },
      'admin',
    );
    expect(eligible.status, JSON.stringify(eligible.body)).toBe(201);
    const team = await send(
      'post',
      path('a', 'team-members'),
      { userId: people.rev, reason: 'Field reviewer', idempotencyKey: newKey() },
      'pe',
    );
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    const assigned = await send(
      'post',
      path('a', 'reviewer-assignments'),
      {
        reviewerUserId: people.rev,
        scopeCode: scope,
        reason: 'Reviews field reports',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    // Assigned and eligible, but not approved by the lead: refused.
    expect(await canOnA(people.rev!, 'concrete.review', scope)).toBe(false);

    const assignment = projectReviewersSchema
      .parse(assigned.body)
      .active.find((a) => a.reviewer.userId === people.rev)!;
    const approved = await send(
      'post',
      path('a', `reviewer-assignments/${assignment.id}/approval`),
      { idempotencyKey: newKey() },
      'pe',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(await canOnA(people.rev!, 'concrete.review', scope)).toBe(true);
    // Per scope: not a strength reviewer, and never through another project.
    expect(await canOnA(people.rev!, 'concrete.review', 'concrete_strength')).toBe(false);

    // Eligibility revoked: the approval ends with it (MISC-08) and review is refused again.
    const grants = await get(`/api/staff/${people.rev}/grants`, 'admin');
    const eligibility = staffGrantsSchema.parse(grants.body).reviewerEligibility.active[0]!;
    const ended = await send(
      'delete',
      `/api/staff/${people.rev}/reviewer-eligibility/${eligibility.id}`,
      { reason: 'No longer reviewing field reports' },
      'admin',
    );
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(await canOnA(people.rev!, 'concrete.review', scope)).toBe(false);
    // LAB never reviews, whatever is assigned.
    expect(
      can(await principal(people.lab!), 'concrete.review', {
        leadProjectEngineerUserId: people.pe!,
        designatedReviewerUserIds: [people.lab!],
      }),
    ).toBe(false);
  });
});
