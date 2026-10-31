import {
  actionRequestListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  projectCapabilitiesSchema,
  projectDetailSchema,
  projectLeadNominationsSchema,
  projectListPageSchema,
  projectSummarySchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { testDatabaseUrl } from '../test-support/database.js';

// MM-AO04 project creation, lead nomination and confirmation, unassigned projects and lead
// handover (card AC1–AC4, test plan §8). Real PostgreSQL, direct API calls. Fictional data only:
// DEMO-2601 (A) and DEMO-2602 (B) start with Pat Example (`pe`) as Lead Project Engineer; Alex
// Tester (`tech`) is ordinary staff, Admin Example (`admin`) an admin, LAB the shared station.
describe.runIf(testDatabaseUrl)('project lead appointment (MM-AO04)', () => {
  let h: LabHarness;
  let moisture: string;
  type As = Parameters<LabHarness['send']>[3];

  let sequence = 0;
  const number = () => `AO4-${String((sequence += 1)).padStart(3, '0')}`;

  const create = (as: As, body: Record<string, unknown> = {}) =>
    h.send(
      'post',
      '/api/projects',
      { projectNumber: number(), name: 'Fictional works', client: 'Example Client', ...body },
      as,
    );
  const nominations = async (projectId: string, as: As = 'tech') => {
    const response = await h.get(`/api/projects/${projectId}/lead-nominations`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectLeadNominationsSchema.parse(response.body);
  };
  const decide = (
    projectId: string,
    nominationId: string,
    action: 'confirm' | 'reject' | 'withdraw',
    as: As,
    reason: string | null = 'Checked with the engineering manager',
  ) =>
    h.send(
      'post',
      `/api/projects/${projectId}/lead-nominations/${nominationId}/${action}`,
      reason === null ? {} : { reason },
      as,
    );
  const detail = async (projectId: string, as: As = 'tech') =>
    projectDetailSchema.parse((await h.get(`/api/projects/${projectId}`, as)).body);
  const inbox = async (as: As) =>
    actionRequestListSchema.parse((await h.get('/api/action-items?status=open', as)).body).items;
  const leadItems = async (projectId: string) =>
    (
      await h.db.pool.query<{ status: string; resolution: string | null }>(
        `SELECT status, resolution FROM action_item
         WHERE kind = 'lead_appointment' AND project_id = $1 ORDER BY created_at, id`,
        [projectId],
      )
    ).rows;

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC-AO4', 'Moisture content (fictional)', 'Moisture')).id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('AC1: a nomination at creation makes nobody the lead; admins get the intake request', async () => {
    const created = await create('tech', {
      leadNomineeUserId: h.users.pe,
      nominationNote: 'Pat ran the 2025 phase',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const project = projectSummarySchema.parse(created.body);
    expect(project.leadProjectEngineer).toBeNull();

    const shown = await detail(project.id);
    expect(shown.leadNomination).toMatchObject({
      status: 'pending',
      nominee: { userId: h.users.pe },
      nominatedBy: { userId: h.users.tech },
      note: 'Pat ran the 2025 phase',
    });
    // Neither the creator nor the nominee gets any lead power (blocked: no lead yet).
    for (const who of ['tech', 'pe'] as const) {
      const caps = projectCapabilitiesSchema.parse(
        (await h.get(`/api/projects/${project.id}/capabilities`, who)).body,
      );
      expect(caps.involvement).toEqual([]);
      const close = caps.capabilities.find((c) => c.action === 'program.close')!;
      expect(close.allowed).toBe(false);
      expect(close.blocked?.code).toBe('no_lead_project_engineer');
      expect(caps.capabilities.find((c) => c.action === 'project.edit')!.allowed).toBe(false);
    }
    // One admin intake request, in admins' inboxes only.
    expect(await leadItems(project.id)).toEqual([{ status: 'open', resolution: null }]);
    const adminInbox = await inbox('admin');
    expect(adminInbox.find((i) => i.projectId === project.id)).toMatchObject({
      kind: 'lead_appointment',
      routedTo: 'Admins',
      href: `/projects/${project.id}#lead`,
    });
    for (const who of ['tech', 'pe', 'lm'] as const) {
      expect((await inbox(who)).some((i) => i.projectId === project.id)).toBe(false);
    }
    // Waiting for a lead is a list filter (D02).
    const waiting = projectListPageSchema.parse(
      (await h.get('/api/projects?waitingForLead=true&pageSize=100', 'tech')).body,
    );
    expect(waiting.items.map((p) => p.id)).toContain(project.id);
    expect(waiting.items.every((p) => p.leadProjectEngineer === null)).toBe(true);
  });

  it('AC1 / D02: LAB creates and nominates for the selected person; the project receives work with no lead', async () => {
    const created = await create('lab', {
      leadNomineeUserId: h.users.pe,
      receiverUserId: h.users.tech,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const project = projectSummarySchema.parse(created.body);
    const pending = (await nominations(project.id)).pending!;
    expect(pending.nominatedBy.userId).toBe(h.users.lab);
    const [event] = await listAuditForEntity(h.db.pool, 'project_lead_nomination', pending.id);
    expect(event).toMatchObject({
      action: 'project_lead_nomination.nominated',
      actorAccountType: 'shared_lab',
      receiverUserId: h.users.tech,
    });
    // Receiving continues: a test hole can be added to a project with no lead.
    const hole = await h.send(
      'post',
      `/api/projects/${project.id}/test-holes`,
      { name: 'TH26-01', receiverUserId: h.users.tech },
      'lab',
    );
    expect(hole.status, JSON.stringify(hole.body)).toBe(201);
    // LAB never nominates afterwards or appoints itself.
    expect(
      (await create('lab', { appointSelfAsLead: true, receiverUserId: h.users.tech })).status,
    ).toBe(403);
  });

  it('AC3: only a holder of "Can create and lead projects" appoints themselves, and only while creating', async () => {
    const before = await h.db.pool.query('SELECT count(*)::int AS n FROM project');
    const denied = await create('tech', { appointSelfAsLead: true });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('self_appointment_not_permitted');
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM project')).rows).toEqual(
      before.rows,
    );
    // Both at once is a validation error.
    expect(
      (await create('tech', { appointSelfAsLead: true, leadNomineeUserId: h.users.pe })).status,
    ).toBe(400);

    const granted = await h.send(
      'post',
      `/api/staff/${h.users.js}/capabilities`,
      {
        capability: 'project.create_and_lead',
        reason: 'Leads small jobs',
        idempotencyKey: newKey(),
      },
      'admin',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const own = await create('js', { appointSelfAsLead: true });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const project = projectSummarySchema.parse(own.body);
    expect(project.leadProjectEngineer?.id).toBe(h.users.js);
    expect(await leadItems(project.id)).toEqual([]);
    const events = await listAuditForEntity(h.db.pool, 'project', project.id);
    expect(events.map((e) => e.action).sort()).toEqual([
      'project.created',
      'project.lead_appointed',
    ]);
    expect(events.find((e) => e.action === 'project.lead_appointed')!.after).toMatchObject({
      via: 'self_appointment',
    });
    // The capability lets js lead their own new project only: nominating someone else stays a
    // nomination, and js gets nothing on existing projects.
    const other = projectSummarySchema.parse(
      (await create('js', { leadNomineeUserId: h.users.jo })).body,
    );
    expect(other.leadProjectEngineer).toBeNull();
    const onA = projectCapabilitiesSchema.parse(
      (await h.get(`/api/projects/${h.projects.a}/capabilities`, 'js')).body,
    );
    expect(onA.capabilities.find((c) => c.action === 'project.edit')!.allowed).toBe(false);

    // Revoked: self-appointment is refused again.
    const grantId = granted.body.capabilities.active[0].id as string;
    expect(
      (
        await h
          .http()
          .delete(`/api/staff/${h.users.js}/capabilities/${grantId}`)
          .set('Cookie', await h.cookie('admin'))
          .set('x-materialmule-csrf', '1')
          .send({ reason: 'No longer leading' })
      ).status,
    ).toBe(200);
    expect((await create('js', { appointSelfAsLead: true })).status).toBe(403);
  });

  it('AC2: an admin confirms with a reason; one effective lead and the full history are kept', async () => {
    const project = projectSummarySchema.parse(
      (await create('tech', { leadNomineeUserId: h.users.jo })).body,
    );
    const pending = (await nominations(project.id)).pending!;
    // Only admins decide; rejecting needs a reason (MISC-03: confirming doesn't).
    for (const who of ['tech', 'jo', 'lm', 'pe', 'lab'] as const) {
      expect((await decide(project.id, pending.id, 'confirm', who)).status, who).toBe(403);
      expect((await decide(project.id, pending.id, 'confirm', who, null)).status, who).toBe(403);
    }
    expect((await decide(project.id, pending.id, 'reject', 'admin', null)).status).toBe(400);
    expect((await decide(project.id, pending.id, 'reject', 'admin', '  ')).status).toBe(400);
    expect((await detail(project.id)).leadProjectEngineer).toBeNull();

    const confirmed = await decide(project.id, pending.id, 'confirm', 'admin');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const view = projectLeadNominationsSchema.parse(confirmed.body);
    expect(view).toMatchObject({ hasLead: true, pending: null, canNominate: false });
    expect(view.history[0]).toMatchObject({
      status: 'confirmed',
      decidedBy: { userId: h.users.admin },
      decisionReason: 'Checked with the engineering manager',
    });
    expect((await detail(project.id)).leadProjectEngineer?.id).toBe(h.users.jo);
    expect(await leadItems(project.id)).toEqual([{ status: 'resolved', resolution: 'appointed' }]);
    const appointed = (await listAuditForEntity(h.db.pool, 'project', project.id)).find(
      (e) => e.action === 'project.lead_appointed',
    );
    expect(appointed).toMatchObject({
      actorUserId: h.users.admin,
      reason: 'Checked with the engineering manager',
      after: { leadProjectEngineerUserId: h.users.jo, via: 'nomination', nominationId: pending.id },
    });
    // The new lead now holds the lead's powers here.
    const caps = projectCapabilitiesSchema.parse(
      (await h.get(`/api/projects/${project.id}/capabilities`, 'jo')).body,
    );
    expect(caps.involvement).toEqual(['lead_project_engineer']);
    // An exact retry returns the same state; a different decision on it is a conflict.
    expect((await decide(project.id, pending.id, 'confirm', 'admin')).status).toBe(200);
    const late = await decide(project.id, pending.id, 'reject', 'admin');
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'nomination_decided', status: 'confirmed' });
  });

  it('MISC-03: an admin confirms with no reason; the appointment and its audit are still recorded', async () => {
    for (const reason of [null, '']) {
      const project = projectSummarySchema.parse(
        (await create('tech', { leadNomineeUserId: h.users.jo })).body,
      );
      const pending = (await nominations(project.id)).pending!;
      const confirmed = await decide(project.id, pending.id, 'confirm', 'admin', reason);
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(projectLeadNominationsSchema.parse(confirmed.body).history[0]).toMatchObject({
        status: 'confirmed',
        decidedBy: { userId: h.users.admin },
        decisionReason: null,
      });
      expect((await detail(project.id)).leadProjectEngineer?.id).toBe(h.users.jo);
      expect(await leadItems(project.id)).toEqual([
        { status: 'resolved', resolution: 'appointed' },
      ]);
      const events = await listAuditForEntity(h.db.pool, 'project', project.id);
      expect(events.find((e) => e.action === 'project.lead_appointed')).toMatchObject({
        actorUserId: h.users.admin,
        reason: null,
      });
      const decided = await listAuditForEntity(h.db.pool, 'project_lead_nomination', pending.id);
      expect(decided.map((e) => e.action)).toContain('project_lead_nomination.confirmed');
    }
  });

  it('rejecting or withdrawing keeps the project waiting; anyone may then nominate again', async () => {
    const project = projectSummarySchema.parse(
      (await create('tech', { leadNomineeUserId: h.users.jo })).body,
    );
    const first = (await nominations(project.id)).pending!;
    // Only the nominator withdraws.
    expect((await decide(project.id, first.id, 'withdraw', 'jo')).status).toBe(403);
    const withdrawn = await decide(project.id, first.id, 'withdraw', 'tech', 'Wrong person');
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(projectLeadNominationsSchema.parse(withdrawn.body)).toMatchObject({
      hasLead: false,
      pending: null,
      canNominate: true,
    });
    expect(await leadItems(project.id)).toEqual([{ status: 'open', resolution: null }]);

    const nominate = (as: As, nomineeUserId: string, key = newKey()) =>
      h.send(
        'post',
        `/api/projects/${project.id}/lead-nominations`,
        { nomineeUserId, note: '', idempotencyKey: key },
        as,
      );
    expect((await nominate('lab', h.users.pe)).status).toBe(403);
    expect((await nominate('tech', h.users.lab)).body.code).toBe('invalid_recipient');
    const key = newKey();
    const second = await nominate('lm', h.users.pe, key);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await nominate('lm', h.users.pe, key)).status).toBe(201);
    expect((await nominate('tech', h.users.js)).body.code).toBe('nomination_pending');
    const pending = projectLeadNominationsSchema.parse(second.body).pending!;
    expect(pending.note).toBeNull();
    expect((await decide(project.id, pending.id, 'reject', 'admin', 'Not available')).status).toBe(
      200,
    );
    const after = await nominations(project.id);
    expect(after.history.map((n) => n.status)).toEqual(['rejected', 'withdrawn']);
    expect(await leadItems(project.id)).toEqual([{ status: 'open', resolution: null }]);
    // Still only one open intake request for the project.
    expect((await inbox('admin')).filter((i) => i.projectId === project.id)).toHaveLength(1);
  });

  it('AC4: an admin appoints or removes a lead directly with a reason; grants survive, the intake request follows', async () => {
    const project = projectSummarySchema.parse(
      (await create('tech', { leadNomineeUserId: h.users.jo })).body,
    );
    const patch = async (body: Record<string, unknown>, as: As = 'admin') =>
      h.send(
        'patch',
        `/api/projects/${project.id}`,
        { version: (await detail(project.id)).version, ...body },
        as,
      );
    // A direct appointment of someone else closes the pending nomination as rejected.
    const appointed = await patch({ leadProjectEngineerId: h.users.pe, reason: 'Pat takes it' });
    expect(appointed.status, JSON.stringify(appointed.body)).toBe(200);
    const history = (await nominations(project.id)).history;
    expect(history[0]).toMatchObject({ status: 'rejected', decisionReason: 'Pat takes it' });
    expect(await leadItems(project.id)).toEqual([{ status: 'resolved', resolution: 'appointed' }]);

    // Pat grants a delegate, then an admin removes Pat: the grant survives (D08), the intake
    // request reopens, lead-only actions are blocked with a reason, the delegate still accepts.
    const delegated = await h.send(
      'post',
      `/api/projects/${project.id}/acceptance-delegates`,
      { delegateUserId: h.users.js, reason: 'Covers acceptance', idempotencyKey: newKey() },
      'pe',
    );
    expect(delegated.status, JSON.stringify(delegated.body)).toBe(201);
    expect((await patch({ leadProjectEngineerId: null })).status).toBe(400);
    expect(
      (await patch({ leadProjectEngineerId: null, reason: 'Pat left the firm' }, 'pe')).status,
    ).toBe(403);
    const removed = await patch({ leadProjectEngineerId: null, reason: 'Pat left the firm' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(projectDetailSchema.parse(removed.body).leadProjectEngineer).toBeNull();
    expect(await leadItems(project.id)).toEqual([
      { status: 'resolved', resolution: 'appointed' },
      { status: 'open', resolution: null },
    ]);
    const delegates = (await h.get(`/api/projects/${project.id}/acceptance-delegates`, 'tech'))
      .body;
    expect(
      delegates.active.map((d: { delegate: { userId: string } }) => d.delegate.userId),
    ).toEqual([h.users.js]);
    const former = projectCapabilitiesSchema.parse(
      (await h.get(`/api/projects/${project.id}/capabilities`, 'pe')).body,
    );
    expect(former.capabilities.find((c) => c.action === 'program.close')!.blocked?.code).toBe(
      'no_lead_project_engineer',
    );
    const delegate = projectCapabilitiesSchema.parse(
      (await h.get(`/api/projects/${project.id}/capabilities`, 'js')).body,
    );
    expect(delegate.capabilities.find((c) => c.action === 'test.accept')!.allowed).toBe(true);
    // Historical attribution is untouched: the grant still names Pat as grantor.
    expect(delegates.active[0].grantedBy.userId).toBe(h.users.pe);
  });

  it('D02 / queued: a closure request on a project with no lead waits, then reaches the next lead', async () => {
    // B loses its lead.
    const version = (await detail(h.projects.b)).version;
    expect(
      (
        await h.send(
          'patch',
          `/api/projects/${h.projects.b}`,
          { version, leadProjectEngineerId: null, reason: 'Reorganising' },
          'admin',
        )
      ).status,
    ).toBe(200);
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
    const program = labProgramSchema.parse(submitted.body);
    const requested = await h.send(
      'post',
      `/api/lab-programs/${program.id}/close-request`,
      { reason: 'All testing is done', idempotencyKey: newKey() },
      'tech',
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const all = actionRequestListSchema.parse(
      (await h.get('/api/action-items?status=open&scope=all', 'lm')).body,
    ).items;
    expect(
      all.find((i) => i.kind === 'closure_request' && i.projectId === h.projects.b),
    ).toMatchObject({
      routedTo: 'Waiting for a Lead Project Engineer',
    });
    // Nobody can close it now; once Jamie is appointed it is in Jamie's inbox.
    expect((await inbox('pe')).some((i) => i.kind === 'closure_request')).toBe(false);
    expect(
      (
        await h.send(
          'patch',
          `/api/projects/${h.projects.b}`,
          {
            version: (await detail(h.projects.b)).version,
            leadProjectEngineerId: h.users.jo,
            reason: 'Jamie takes B',
          },
          'admin',
        )
      ).status,
    ).toBe(200);
    expect(
      (await inbox('jo')).find((i) => i.kind === 'closure_request' && i.projectId === h.projects.b),
    ).toMatchObject({ routedTo: 'Lead Project Engineer' });
  });

  it('AC2 / D09: two admins deciding one nomination at once: exactly one decision wins', async () => {
    const project = projectSummarySchema.parse(
      (await create('tech', { leadNomineeUserId: h.users.pe })).body,
    );
    const pending = (await nominations(project.id)).pending!;
    const outcomes = await Promise.all([
      decide(project.id, pending.id, 'confirm', 'admin', 'Confirmed'),
      decide(project.id, pending.id, 'reject', 'admin', 'Rejected'),
    ]);
    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses).toEqual([200, 409]);
    const final = await nominations(project.id);
    expect(final.history).toHaveLength(1);
    const lead = (await detail(project.id)).leadProjectEngineer;
    expect(lead === null ? 'rejected' : 'confirmed').toBe(final.history[0]!.status);
    const { rows } = await h.db.pool.query(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE entity_id = $1 AND action LIKE 'project_lead_nomination.%'`,
      [pending.id],
    );
    // Nominated + exactly one decision.
    expect(rows[0]).toEqual({ n: 2 });
  });
});
