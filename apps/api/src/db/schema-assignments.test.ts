import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { runSeed } from './seed.js';

// MM-AO02: project assignment and scoped-grant storage (owner decisions D01–D16), proven in the
// database itself. Storage only: who may write these rows is MM-AO03's policy. Fictional data only
// (DEMO-2601, test identities).

describe.runIf(testDatabaseUrl)('project assignments and scoped grants (MM-AO02)', () => {
  let db: TestSchema;
  let lead: string;
  let admin: string;
  let engineer: string;
  let lab: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await insertUser(db.pool, 'PE');
    admin = await insertUser(db.pool, 'AD');
    engineer = await insertUser(db.pool, 'DE');
    lab = (
      await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, account_type, status)
         VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
      )
    ).rows[0]!.id;
    projectId = await insertProject(db.pool, 'DEMO-2601', lead);
    otherProjectId = await insertProject(db.pool, 'DEMO-2602', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  const insert = async (table: string, values: Record<string, unknown>) => {
    const keys = Object.keys(values);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO ${table} (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
    return rows[0]!.id;
  };

  const issuerGrant = (values: Record<string, unknown> = {}) =>
    insert('project_report_issuer_grant', {
      project_id: projectId,
      issuer_user_id: engineer,
      issuer_name_snapshot: 'Test DE',
      report_scope_code: 'concrete_strength',
      granted_by_user_id: lead,
      granted_by_name_snapshot: 'Test PE',
      grant_reason: 'Experienced with strength reports',
      grant_idempotency_key: randomUUID(),
      grant_request_hash: 'h',
      ...values,
    });

  const revoke = (table: string, id: string, values: Record<string, unknown>) => {
    const keys = Object.keys(values);
    return db.pool.query(
      `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...Object.values(values)],
    );
  };

  const issuerRevocation = (kind = 'ordinary') => ({
    revoked_at: new Date(Date.now() + 1000).toISOString(),
    revoked_by_user_id: lead,
    revoked_by_name_snapshot: 'Test PE',
    revoke_reason: 'No longer issuing for this project',
    revocation_kind: kind,
  });

  it('keeps one effective Lead Project Engineer on the project row (optional since MM-AO04, D02)', async () => {
    const { rows } = await db.pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'project'
         AND column_name LIKE '%engineer%' ORDER BY column_name`,
    );
    // The single review engineer was retired by 0002 (MM-AO03, D12).
    expect(rows).toEqual([{ column_name: 'lead_project_engineer_user_id', is_nullable: 'YES' }]);
    // No retired project-role names remain anywhere in the schema.
    const legacy = await db.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name ~ '(^|_)pm(_|$)|pm_pe'`,
    );
    expect(legacy.rows).toEqual([]);
    const functions = await db.pool.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = current_schema() AND (proname ~ 'pm_pe' OR prosrc ~ 'pm_pe')`,
    );
    expect(functions.rows).toEqual([]);
  });

  it('seeds the workflow / report-type scopes and refuses deleting one', async () => {
    const { rows } = await db.pool.query(
      'SELECT code, label FROM review_scope ORDER BY sort_order',
    );
    expect(rows).toEqual([
      { code: 'concrete_field', label: 'Concrete field reports' },
      { code: 'concrete_strength', label: 'Concrete strength reports' },
    ]);
    await expect(
      db.pool.query(`DELETE FROM review_scope WHERE code = 'concrete_field'`),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      db.pool.query(`INSERT INTO review_scope (code, label) VALUES ('Bad Code', 'X')`),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });

  describe('report issuer grants (D06/D07)', () => {
    it('needs a reason, a known scope and a personal recipient; reference and expiry optional', async () => {
      await expect(issuerGrant({ grant_reason: '  ' })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(issuerGrant({ report_scope_code: 'soils' })).rejects.toMatchObject({
        code: PG.foreignKeyViolation,
      });
      await expect(
        issuerGrant({ issuer_user_id: lab, issuer_name_snapshot: 'LAB' }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        issuerGrant({ expires_at: '2020-01-01T00:00:00Z', project_id: otherProjectId }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        issuerGrant({ approval_reference: ' padded ', project_id: otherProjectId }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      const id = await issuerGrant({
        project_id: otherProjectId,
        approval_reference: 'QA-2026-014',
        expires_at: '2027-10-29T00:00:00Z',
      });
      expect(id).toBeTruthy();
    });

    it('allows one active grant per project, person and scope; scopes and projects are separate', async () => {
      const first = await issuerGrant();
      await expect(issuerGrant()).rejects.toMatchObject({ code: PG.uniqueViolation });
      // Another scope, or the same scope on another project, is its own grant.
      await expect(issuerGrant({ report_scope_code: 'concrete_field' })).resolves.toBeTruthy();
      // After revocation, a new grant can follow.
      await revoke('project_report_issuer_grant', first, issuerRevocation('emergency'));
      await expect(issuerGrant()).resolves.toBeTruthy();
      const { rows } = await db.pool.query(
        `SELECT revocation_kind FROM project_report_issuer_grant WHERE id = $1`,
        [first],
      );
      expect(rows).toEqual([{ revocation_kind: 'emergency' }]);
    });

    it('revokes once, with who, why and a kind; the grant itself never changes; never deleted', async () => {
      const id = await issuerGrant({
        project_id: otherProjectId,
        report_scope_code: 'concrete_field',
      });
      const { revocation_kind: _kind, ...withoutKind } = issuerRevocation();
      await expect(revoke('project_report_issuer_grant', id, withoutKind)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      const { revoke_reason: _reason, ...withoutReason } = issuerRevocation();
      await expect(revoke('project_report_issuer_grant', id, withoutReason)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(
        revoke('project_report_issuer_grant', id, { grant_reason: 'Rewritten' }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        revoke('project_report_issuer_grant', id, { ...issuerRevocation(), issuer_user_id: lead }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await revoke('project_report_issuer_grant', id, issuerRevocation());
      await expect(
        revoke('project_report_issuer_grant', id, issuerRevocation('emergency')),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query('DELETE FROM project_report_issuer_grant WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
    });
  });

  describe('team, reviewers and eligibility (D04/D05)', () => {
    const member = (values: Record<string, unknown> = {}) =>
      insert('project_team_member', {
        project_id: projectId,
        user_id: engineer,
        user_name_snapshot: 'Test DE',
        added_by_user_id: lead,
        added_by_name_snapshot: 'Test PE',
        add_reason: 'Supporting the field program',
        add_idempotency_key: randomUUID(),
        add_request_hash: 'h',
        ...values,
      });
    const reviewer = (values: Record<string, unknown> = {}) =>
      insert('project_reviewer_assignment', {
        project_id: projectId,
        reviewer_user_id: engineer,
        reviewer_name_snapshot: 'Test DE',
        scope_code: 'concrete_field',
        assigned_by_user_id: admin,
        assigned_by_name_snapshot: 'Test AD',
        assign_reason: 'Concrete field reviewer for this project',
        assign_idempotency_key: randomUUID(),
        assign_request_hash: 'h',
        ...values,
      });
    const eligibility = (values: Record<string, unknown> = {}) =>
      insert('reviewer_eligibility', {
        user_id: engineer,
        user_name_snapshot: 'Test DE',
        scope_code: 'concrete_field',
        granted_by_user_id: admin,
        granted_by_name_snapshot: 'Test AD',
        grant_reason: 'Field testing certification on file',
        grant_idempotency_key: randomUUID(),
        grant_request_hash: 'h',
        ...values,
      });
    const removal = () => ({
      removed_at: '2099-01-01T00:00:00Z',
      removed_by_user_id: lead,
      removed_by_name_snapshot: 'Test PE',
      remove_reason: 'Moved to another project',
    });

    it('a person is an active team member once per project; removal is recorded once', async () => {
      const id = await member();
      await expect(member()).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(member({ project_id: otherProjectId })).resolves.toBeTruthy();
      await expect(member({ project_id: otherProjectId, user_id: lab })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(
        revoke('project_team_member', id, { ...removal(), remove_reason: null }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await revoke('project_team_member', id, removal());
      await expect(revoke('project_team_member', id, removal())).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
      // History stays; the person can be added again.
      await expect(member()).resolves.toBeTruthy();
    });

    it('many scoped reviewers per project; one active assignment per person and scope', async () => {
      await reviewer();
      await expect(reviewer()).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(reviewer({ scope_code: 'concrete_strength' })).resolves.toBeTruthy();
      await expect(
        reviewer({ reviewer_user_id: lead, reviewer_name_snapshot: 'Test PE' }),
      ).resolves.toBeTruthy();
      await expect(reviewer({ scope_code: 'everything' })).rejects.toMatchObject({
        code: PG.foreignKeyViolation,
      });
      await expect(reviewer({ assign_reason: null })).rejects.toMatchObject({
        code: PG.notNullViolation,
      });
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS active FROM project_reviewer_assignment
         WHERE project_id = $1 AND removed_at IS NULL`,
        [projectId],
      );
      expect(rows[0]).toEqual({ active: 3 });
    });

    it('reviewer eligibility is per person and scope, revocable once with a reason', async () => {
      const id = await eligibility();
      await expect(eligibility()).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(eligibility({ user_id: lab, user_name_snapshot: 'LAB' })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await revoke('reviewer_eligibility', id, {
        revoked_at: new Date(Date.now() + 1000).toISOString(),
        revoked_by_user_id: admin,
        revoked_by_name_snapshot: 'Test AD',
        revoke_reason: 'Certification lapsed',
      });
      await expect(eligibility()).resolves.toBeTruthy();
    });
  });

  describe('lead nominations and the self-lead capability (D01)', () => {
    const nomination = (values: Record<string, unknown> = {}) =>
      insert('project_lead_nomination', {
        project_id: otherProjectId,
        nominee_user_id: engineer,
        nominee_name_snapshot: 'Test DE',
        nominated_by_user_id: lab,
        nominated_by_name_snapshot: 'LAB',
        nomination_idempotency_key: randomUUID(),
        nomination_request_hash: 'h',
        ...values,
      });

    it('one pending nomination per project; deciding needs who (and a reason to reject), once', async () => {
      const id = await nomination();
      await expect(nomination()).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(
        nomination({ project_id: projectId, nominee_user_id: lab, nominee_name_snapshot: 'LAB' }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      const decision = {
        status: 'confirmed',
        decided_at: new Date(Date.now() + 1000).toISOString(),
        decided_by_user_id: admin,
        decided_by_name_snapshot: 'Test AD',
        decision_reason: null,
      };
      // MISC-03: rejecting or withdrawing needs a reason; confirming doesn't (0010).
      for (const status of ['rejected', 'withdrawn']) {
        await expect(
          revoke('project_lead_nomination', id, { ...decision, status }),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      }
      await expect(
        revoke('project_lead_nomination', id, { ...decision, decided_by_name_snapshot: null }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        revoke('project_lead_nomination', id, { ...decision, nominee_user_id: admin }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await revoke('project_lead_nomination', id, decision);
      await expect(
        revoke('project_lead_nomination', id, { ...decision, status: 'rejected' }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      // A nomination never changes the effective lead by itself.
      const { rows } = await db.pool.query(
        'SELECT lead_project_engineer_user_id AS lead FROM project WHERE id = $1',
        [otherProjectId],
      );
      expect(rows[0]).toEqual({ lead });
      await expect(nomination()).resolves.toBeTruthy();
    });

    it('the create-and-lead capability is explicit, one active per person, never for LAB', async () => {
      const capability = (values: Record<string, unknown> = {}) =>
        insert('staff_capability_grant', {
          user_id: engineer,
          user_name_snapshot: 'Test DE',
          capability: 'project.create_and_lead',
          granted_by_user_id: admin,
          granted_by_name_snapshot: 'Test AD',
          grant_reason: 'Leads small projects from intake',
          grant_idempotency_key: randomUUID(),
          grant_request_hash: 'h',
          ...values,
        });
      await capability();
      await expect(capability()).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(capability({ capability: 'project.issue_reports' })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(capability({ user_id: lab, user_name_snapshot: 'LAB' })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
    });
  });

  describe('existing records extended (D15, D16)', () => {
    it('acceptance delegations keep optional reasons; the grant reason never changes', async () => {
      const id = await insert('acceptance_delegation', {
        project_id: projectId,
        delegate_user_id: engineer,
        delegate_name_snapshot: 'Test DE',
        granted_by_user_id: lead,
        granted_by_name_snapshot: 'Test PE',
        grant_idempotency_key: randomUUID(),
        grant_request_hash: 'h',
        grant_reason: 'Covers acceptance while on leave',
      });
      await expect(
        revoke('acceptance_delegation', id, { revoke_reason: 'Back from leave' }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        revoke('acceptance_delegation', id, { grant_reason: 'Rewritten' }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await revoke('acceptance_delegation', id, {
        revoked_at: new Date(Date.now() + 1000).toISOString(),
        revoked_by_user_id: lead,
        revoked_by_name_snapshot: 'Test PE',
        revoke_reason: 'Back from leave',
      });
    });

    it('a job-title override records who set it and when, apart from the Graph title', async () => {
      const set = (values: Record<string, unknown>) => revoke('app_user', engineer, values);
      await expect(set({ job_title_override: 'Senior Engineer' })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await set({
        job_title: 'Engineer II',
        job_title_override: 'Senior Engineer',
        job_title_override_set_by_user_id: admin,
        job_title_override_set_at: new Date().toISOString(),
      });
      const { rows } = await db.pool.query(
        'SELECT job_title, job_title_override FROM app_user WHERE id = $1',
        [engineer],
      );
      expect(rows[0]).toEqual({ job_title: 'Engineer II', job_title_override: 'Senior Engineer' });
    });
  });

  it('AC3: fixtures, titles and delegations infer no assignment or grant', async () => {
    const fresh = await createMigratedSchema();
    try {
      await runSeed(fresh.pool, 'reference', 'test');
      await runSeed(fresh.pool, 'dev', 'test');
      // Legacy-shaped facts that must never become authority: an engineering title and position
      // and an active acceptance delegation (the review-engineer field is retired, MM-AO03).
      const demo = '00000000-0000-4000-8000-000000000201';
      const dana = '00000000-0000-4000-8000-000000000105';
      const pat = '00000000-0000-4000-8000-000000000101';
      await fresh.pool.query(
        `UPDATE app_user SET job_title = 'Senior Review Engineer', position = 'engineer',
                position_set_at = now() WHERE id = $1`,
        [dana],
      );
      await fresh.pool.query(
        `INSERT INTO acceptance_delegation (project_id, delegate_user_id, delegate_name_snapshot,
                                            granted_by_user_id, granted_by_name_snapshot,
                                            grant_reason, grant_idempotency_key, grant_request_hash)
         VALUES ($1, $2, 'Dana Example', $3, 'Pat Example', 'Covers acceptance',
                 gen_random_uuid(), 'h')`,
        [demo, dana, pat],
      );
      const { rows } = await fresh.pool.query(
        `SELECT (SELECT count(*)::int FROM project_report_issuer_grant) AS issuers,
                (SELECT count(*)::int FROM reviewer_eligibility) AS eligibility,
                (SELECT count(*)::int FROM project_reviewer_assignment) AS reviewers,
                (SELECT count(*)::int FROM project_team_member) AS team,
                (SELECT count(*)::int FROM project_lead_nomination) AS nominations,
                (SELECT count(*)::int FROM staff_capability_grant) AS capabilities`,
      );
      expect(rows[0]).toEqual({
        issuers: 0,
        eligibility: 0,
        reviewers: 0,
        team: 0,
        nominations: 0,
        capabilities: 0,
      });
    } finally {
      await fresh.drop();
    }
  });

  describe('inherited grant review flags (MTR-25, 0009)', () => {
    const flag = (values: Record<string, unknown>) =>
      insert('project_grant_review', {
        project_id: projectId,
        flagged_for_user_id: engineer,
        ...values,
      });
    const decision = (values: Record<string, unknown> = {}) => ({
      status: 'kept',
      decided_at: new Date(Date.now() + 1000).toISOString(),
      decided_by_user_id: engineer,
      decided_by_name_snapshot: 'Test DE',
      decision_reason: 'Still needed',
      ...values,
    });
    const grantFor = async (initials: string) =>
      issuerGrant({ issuer_user_id: await insertUser(db.pool, initials) });

    it('names exactly one active grant of its own project, pending once per grant', async () => {
      const grant = await grantFor('GRA');
      const other = await grantFor('GRB');
      await expect(
        flag({ report_issuer_grant_id: grant, acceptance_delegation_id: null }),
      ).resolves.toBeTruthy();
      // A second pending flag for the same grant.
      await expect(flag({ report_issuer_grant_id: grant })).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });
      // None, or two grants at once.
      await expect(flag({})).rejects.toMatchObject({ code: PG.checkViolation });
      const reviewer = await db.pool.query<{ id: string }>(
        `SELECT id FROM project_reviewer_assignment LIMIT 1`,
      );
      if (reviewer.rows[0]) {
        await expect(
          flag({ report_issuer_grant_id: other, reviewer_assignment_id: reviewer.rows[0].id }),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      }
      // Another project's grant, or one already ended.
      await expect(
        flag({ project_id: otherProjectId, report_issuer_grant_id: other }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await revoke('project_report_issuer_grant', other, issuerRevocation());
      await expect(flag({ report_issuer_grant_id: other })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
    });

    it('is decided once, with who and a reason, and never deleted', async () => {
      const id = await flag({ report_issuer_grant_id: await grantFor('GRC') });
      await expect(
        revoke('project_grant_review', id, decision({ decision_reason: null })),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        revoke('project_grant_review', id, decision({ decided_by_user_id: null })),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        revoke('project_grant_review', id, decision({ flagged_for_user_id: admin })),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await revoke('project_grant_review', id, decision());
      await expect(
        revoke('project_grant_review', id, decision({ status: 'revoked' })),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query('DELETE FROM project_grant_review WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
    });

    it('ending a flagged grant by any route settles its flag, and the last one resolves the request', async () => {
      const grant = await grantFor('GRD');
      const flagId = await flag({ report_issuer_grant_id: grant });
      // Settle any earlier pending flags on this project so this one is the last.
      await db.pool.query(
        `UPDATE project_grant_review SET status = 'kept', decided_at = now(),
                decided_by_user_id = $2, decided_by_name_snapshot = 'Test DE',
                decision_reason = 'Still needed'
         WHERE project_id = $1 AND status = 'pending' AND id <> $3`,
        [projectId, engineer, flagId],
      );
      const item = await insert('action_item', {
        kind: 'grant_review',
        target_user_id: engineer,
        entity_type: 'project',
        entity_id: projectId,
        project_id: projectId,
        created_by_user_id: admin,
        created_by_name_snapshot: 'Test AD',
        reason: 'DEMO-2601: new Lead Project Engineer; 1 inherited grant to keep or revoke',
      });
      // The request needs a named lead.
      await expect(
        insert('action_item', {
          kind: 'grant_review',
          entity_type: 'project',
          entity_id: otherProjectId,
          project_id: otherProjectId,
          created_by_user_id: admin,
          created_by_name_snapshot: 'Test AD',
          reason: 'No target',
        }),
      ).rejects.toMatchObject({ code: PG.checkViolation });

      await revoke('project_report_issuer_grant', grant, issuerRevocation());
      const { rows } = await db.pool.query(
        `SELECT status, decided_by_user_id, decision_reason FROM project_grant_review
         WHERE id = $1`,
        [flagId],
      );
      expect(rows[0]).toEqual({
        status: 'revoked',
        decided_by_user_id: lead,
        decision_reason: 'No longer issuing for this project',
      });
      const resolved = await db.pool.query(
        `SELECT status, resolution, resolved_by_user_id FROM action_item WHERE id = $1`,
        [item],
      );
      expect(resolved.rows[0]).toEqual({
        status: 'resolved',
        resolution: 'reviewed',
        resolved_by_user_id: lead,
      });
    });
  });

  describe('team join requests (MISC-07, 0011)', () => {
    const member = async (userId: string, addedBy = userId, project = projectId) =>
      insert('project_team_member', {
        project_id: project,
        user_id: userId,
        user_name_snapshot: 'Test joiner',
        added_by_user_id: addedBy,
        added_by_name_snapshot: 'Test joiner',
        add_reason: 'Asked to join the team',
        add_idempotency_key: randomUUID(),
        add_request_hash: 'h',
      });
    const request = (userId: string, teamMemberId: string, project = projectId) =>
      insert('project_team_join_request', {
        project_id: project,
        user_id: userId,
        team_member_id: teamMemberId,
        request_idempotency_key: randomUUID(),
      });
    const removal = (by: string) => ({
      removed_at: new Date(Date.now() + 1000).toISOString(),
      removed_by_user_id: by,
      removed_by_name_snapshot: 'Test PE',
      remove_reason: 'Not on this project',
    });

    it('needs the requester’s own active membership of that project; one pending per person', async () => {
      const joiner = await insertUser(db.pool, 'JNA');
      const own = await member(joiner);
      // Someone else's membership, one added by another person, or another project's.
      const other = await insertUser(db.pool, 'JNB');
      await expect(request(other, own)).rejects.toMatchObject({ code: PG.checkViolation });
      const addedByLead = await member(other, lead);
      await expect(request(other, addedByLead)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(request(joiner, own, otherProjectId)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await request(joiner, own);
      // One request per membership, and one pending per person and project.
      await expect(request(joiner, own)).rejects.toMatchObject({ code: PG.uniqueViolation });
      // LAB never asks.
      await expect(
        db.pool.query(
          `INSERT INTO project_team_join_request
             (project_id, user_id, team_member_id, request_idempotency_key)
           VALUES ($1, $2, $3, $4)`,
          [projectId, lab, own, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('accepting needs who; declining needs a reason; decided once, never deleted', async () => {
      const joiner = await insertUser(db.pool, 'JNC');
      const id = await request(joiner, await member(joiner));
      const decided = {
        status: 'declined',
        decided_at: new Date(Date.now() + 1000).toISOString(),
        decided_by_user_id: lead,
        decided_by_name_snapshot: 'Test PE',
        decision_reason: null,
      };
      await expect(revoke('project_team_join_request', id, decided)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(
        revoke('project_team_join_request', id, {
          ...decided,
          status: 'accepted',
          decided_by_user_id: null,
        }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await revoke('project_team_join_request', id, { ...decided, status: 'accepted' });
      await expect(
        revoke('project_team_join_request', id, { ...decided, decision_reason: 'Changed mind' }),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query('DELETE FROM project_team_join_request WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
    });

    it('removing a pending member declines the request with that removal’s reason; they may ask again', async () => {
      const joiner = await insertUser(db.pool, 'JND');
      const membership = await member(joiner);
      const id = await request(joiner, membership);
      await revoke('project_team_member', membership, removal(lead));
      const { rows } = await db.pool.query(
        `SELECT status, decided_by_user_id, decision_reason FROM project_team_join_request
         WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        status: 'declined',
        decided_by_user_id: lead,
        decision_reason: 'Not on this project',
      });
      await expect(request(joiner, await member(joiner))).resolves.toBeTruthy();
    });
  });
});
