import {
  actionRequestListSchema,
  projectDetailSchema,
  projectGrantReviewsSchema,
  projectReportIssuersSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { insertProject } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { testDatabaseUrl } from '../test-support/database.js';

// MTR-25 (owner decision 2026-10-30): a new Lead Project Engineer reviews the grants the project
// already has. Real PostgreSQL, direct API calls. Fictional data only: a fresh project led by Pat
// Example (`pe`), with Jamie (`js`) as acceptance delegate, Jo (`jo`) as report issuer and Alex
// (`tech`) as reviewer; an admin hands it to the Lab Manager fixture (`lm`).
describe.runIf(testDatabaseUrl)('inherited grant review after a lead change (MTR-25)', () => {
  let h: LabHarness;
  let projectId: string;
  type As = Parameters<LabHarness['send']>[3];

  const reviews = async (as: As = 'tech') => {
    const response = await h.get(`/api/projects/${projectId}/grant-reviews`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectGrantReviewsSchema.parse(response.body);
  };
  const decide = (id: string, action: 'keep' | 'revoke', as: As, reason: string | null = 'Ok') =>
    h.send(
      'post',
      `/api/projects/${projectId}/grant-reviews/${id}/${action}`,
      reason === null ? {} : { reason },
      as,
    );
  const items = async () =>
    (
      await h.db.pool.query<{ status: string; resolution: string | null }>(
        `SELECT status, resolution FROM action_item
         WHERE kind = 'grant_review' AND project_id = $1 ORDER BY created_at, id`,
        [projectId],
      )
    ).rows;
  const inbox = async (as: As) =>
    actionRequestListSchema
      .parse((await h.get('/api/action-items?status=open', as)).body)
      .items.filter((i) => i.projectId === projectId && i.kind === 'grant_review');
  const changeLead = async (lead: string | null, reason: string) => {
    const version = projectDetailSchema.parse(
      (await h.get(`/api/projects/${projectId}`, 'admin')).body,
    ).version;
    const response = await h.send(
      'patch',
      `/api/projects/${projectId}`,
      { version, leadProjectEngineerId: lead, reason },
      'admin',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };

  beforeAll(async () => {
    h = await createLabHarness();
    projectId = await insertProject(h.db.pool, 'MTR25-001', h.users.pe);
    const ok = (response: { status: number; body: unknown }) =>
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    ok(
      await h.send(
        'post',
        `/api/projects/${projectId}/acceptance-delegates`,
        { delegateUserId: h.users.js, reason: 'Covers acceptance', idempotencyKey: newKey() },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        `/api/projects/${projectId}/report-issuers`,
        {
          issuerUserId: h.users.jo,
          scopeCode: 'concrete_field',
          reason: 'Signs field reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
    ok(
      await h.send(
        'post',
        `/api/staff/${h.users.tech}/reviewer-eligibility`,
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
        `/api/projects/${projectId}/reviewer-assignments`,
        {
          reviewerUserId: h.users.tech,
          scopeCode: 'concrete_field',
          reason: 'Reviews field reports',
          idempotencyKey: newKey(),
        },
        'pe',
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('flags every inherited grant for the new lead, with one action request and a History entry', async () => {
    expect((await reviews()).pending).toEqual([]);
    await changeLead(h.users.lm, 'Pat moved to another office');

    const view = await reviews();
    expect(view.canDecide).toBe(false);
    expect(view.pending.map((r) => [r.kind, r.holder.userId, r.flaggedFor.userId]).sort()).toEqual(
      [
        ['acceptance_delegate', h.users.js, h.users.lm],
        ['report_issuer', h.users.jo, h.users.lm],
        ['reviewer', h.users.tech, h.users.lm],
      ].sort(),
    );
    expect(view.leadChanges[0]).toMatchObject({
      lead: { userId: h.users.lm },
      by: { userId: h.users.admin },
      reason: 'Pat moved to another office',
    });
    // The new lead and admins may decide; the old lead may not.
    expect((await reviews('lm')).canDecide).toBe(true);
    expect((await reviews('admin')).canDecide).toBe(true);
    expect((await reviews('pe')).canDecide).toBe(false);
    // One request, in the new lead's inbox only.
    expect(await items()).toEqual([{ status: 'open', resolution: null }]);
    expect(await inbox('lm')).toHaveLength(1);
    expect((await inbox('lm'))[0]!.title).toBe('Review inherited grants on MTR25-001');
    expect(await inbox('pe')).toHaveLength(0);
    // LAB reads none of it.
    expect((await h.get(`/api/projects/${projectId}/grant-reviews`, 'lab')).status).toBe(403);
  });

  it('only the lead or an admin keeps or revokes, each with a reason; the request resolves at the end', async () => {
    const pending = (await reviews()).pending;
    const of = (kind: string) => pending.find((r) => r.kind === kind)!;
    for (const who of ['pe', 'tech', 'js', 'lab'] as const) {
      expect((await decide(of('acceptance_delegate').id, 'keep', who)).status, who).toBe(403);
    }
    expect((await decide(of('acceptance_delegate').id, 'keep', 'lm', null)).status).toBe(400);
    expect((await decide(of('acceptance_delegate').id, 'keep', 'lm', ' ')).status).toBe(400);

    // Keep: the grant stays; the flag records who, when and why.
    const kept = await decide(of('acceptance_delegate').id, 'keep', 'lm', 'Jamie still covers it');
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(projectGrantReviewsSchema.parse(kept.body).history[0]).toMatchObject({
      kind: 'acceptance_delegate',
      status: 'kept',
      decidedBy: { userId: h.users.lm },
      reason: 'Jamie still covers it',
    });
    const delegates = await h.get(`/api/projects/${projectId}/acceptance-delegates`, 'lm');
    expect(
      delegates.body.active.map((d: { delegate: { userId: string } }) => d.delegate.userId),
    ).toEqual([h.users.js]);
    // An exact retry is fine; the other decision on it is a conflict.
    expect(
      (await decide(of('acceptance_delegate').id, 'keep', 'lm', 'Jamie still covers it')).status,
    ).toBe(200);
    expect((await decide(of('acceptance_delegate').id, 'revoke', 'lm')).status).toBe(409);
    expect(await items()).toEqual([{ status: 'open', resolution: null }]);

    // Revoke (an admin): the grant ends with the same reason.
    const revoked = await decide(of('report_issuer').id, 'revoke', 'admin', 'Jo has moved on');
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const issuers = projectReportIssuersSchema.parse(
      (await h.get(`/api/projects/${projectId}/report-issuers`, 'lm')).body,
    );
    expect(issuers.active).toEqual([]);
    expect(issuers.history[0]).toMatchObject({ endReason: 'Jo has moved on' });
    const audit = await listAuditForEntity(
      h.db.pool,
      'project_grant_review',
      of('report_issuer').id,
    );
    expect(audit[0]).toMatchObject({
      action: 'project_grant_review.revoked',
      reason: 'Jo has moved on',
    });

    // Ending the last flagged grant by its own route settles its flag and resolves the request.
    const response = await h
      .http()
      .delete(`/api/projects/${projectId}/reviewer-assignments/${of('reviewer').grantId}`)
      .set('Cookie', await h.cookie('lm'))
      .set('x-materialmule-csrf', '1')
      .send({ reason: 'Field review moves in house' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await reviews('lm');
    expect(after.pending).toEqual([]);
    expect(after.history.find((r) => r.kind === 'reviewer')).toMatchObject({
      status: 'revoked',
      decidedBy: { userId: h.users.lm },
      reason: 'Field review moves in house',
    });
    expect(await items()).toEqual([{ status: 'resolved', resolution: 'reviewed' }]);
    expect(await inbox('lm')).toHaveLength(0);
  });

  it('a later lead change flags what is still active again, and removing the lead flags nothing', async () => {
    await changeLead(null, 'Reorganising');
    expect((await reviews()).pending).toEqual([]);
    await changeLead(h.users.pe, 'Pat is back');
    const view = await reviews('pe');
    expect(view.pending.map((r) => r.kind)).toEqual(['acceptance_delegate']);
    expect(view.leadChanges.slice(0, 2).map((c) => c.lead?.userId ?? null)).toEqual([
      h.users.pe,
      null,
    ]);
    expect((await items()).map((i) => i.status)).toEqual(['resolved', 'open']);
  });
});
