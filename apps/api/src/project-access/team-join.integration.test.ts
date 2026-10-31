import {
  actionRequestListSchema,
  projectTeamJoinRequestsSchema,
  projectTeamSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { insertProject } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { testDatabaseUrl } from '../test-support/database.js';

// MISC-07 (owner decision 2026-10-30): self-join with Lead Project Engineer acceptance. Real
// PostgreSQL, direct API calls. Fictional data only: a fresh project led by Pat Example (`pe`);
// Alex (`tech`) and Jamie (`js`) ask to join; Admin Example (`admin`) and LAB play their parts.
describe.runIf(testDatabaseUrl)('team self-join with lead acceptance (MISC-07)', () => {
  let h: LabHarness;
  let projectId: string;
  type As = Parameters<LabHarness['send']>[3];

  const join = (as: As, key = newKey()) =>
    h.send('post', `/api/projects/${projectId}/team-join-requests`, { idempotencyKey: key }, as);
  const view = async (as: As) => {
    const response = await h.get(`/api/projects/${projectId}/team-join-requests`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectTeamJoinRequestsSchema.parse(response.body);
  };
  const decide = (id: string, action: 'accept' | 'decline', as: As, body: object = {}) =>
    h.send('post', `/api/projects/${projectId}/team-join-requests/${id}/${action}`, body, as);
  const team = async () =>
    projectTeamSchema.parse((await h.get(`/api/projects/${projectId}/team-members`, 'tech')).body);
  const memberships = async (userId: string) =>
    (
      await h.db.pool.query<{ active: boolean }>(
        `SELECT removed_at IS NULL AS active FROM project_team_member
         WHERE project_id = $1 AND user_id = $2 ORDER BY added_at, id`,
        [projectId, userId],
      )
    ).rows.map((r) => r.active);
  const items = async () =>
    (
      await h.db.pool.query<{ status: string; resolution: string | null }>(
        `SELECT status, resolution FROM action_item
         WHERE kind = 'team_join_request' AND project_id = $1 ORDER BY created_at, id`,
        [projectId],
      )
    ).rows;
  const inbox = async (as: As) =>
    actionRequestListSchema
      .parse((await h.get('/api/action-items?status=open', as)).body)
      .items.filter((i) => i.projectId === projectId && i.kind === 'team_join_request');

  beforeAll(async () => {
    h = await createLabHarness();
    projectId = await insertProject(h.db.pool, 'MISC07-001', h.users.pe);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('a request adds them at once, pending; repeats make no duplicates; the lead is told', async () => {
    expect((await view('tech')).canRequest).toBe(true);
    const key = newKey();
    const first = await join('tech', key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const body = projectTeamJoinRequestsSchema.parse(first.body);
    expect(body).toMatchObject({ canRequest: false, mine: { status: 'pending' } });
    expect(body.pending.map((r) => r.person.userId)).toEqual([h.users.tech]);
    // Full team-member access straight away.
    expect((await team()).active.map((m) => m.person.userId)).toContain(h.users.tech);
    // Same key, a new key, or many at once: still one membership and one pending request.
    expect((await join('tech', key)).status).toBe(201);
    const again = await Promise.all([join('tech'), join('tech'), join('tech')]);
    expect(again.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await memberships(h.users.tech)).toEqual([true]);
    expect((await view('pe')).pending).toHaveLength(1);
    // Another person's key is refused.
    expect((await join('js', key)).status).toBe(409);
    // The lead is told; nobody else (admins only while there's no lead).
    expect(await inbox('pe')).toHaveLength(1);
    expect((await inbox('pe'))[0]!.title).toBe('Team join request on MISC07-001');
    expect(await inbox('admin')).toHaveLength(0);
    expect(await items()).toEqual([{ status: 'open', resolution: null }]);
    const requested = await listAuditForEntity(
      h.db.pool,
      'project_team_join_request',
      body.pending[0]!.id,
    );
    expect(requested.map((e) => e.action)).toEqual(['project_team_join_request.requested']);
  });

  it('LAB, the lead and anyone not active cannot ask', async () => {
    expect((await join('lab')).status).toBe(403);
    expect((await join('disabled')).status).toBe(401);
    expect((await join('pe')).status).toBe(422);
    expect((await view('pe')).canRequest).toBe(false);
  });

  it('only the lead or an admin accepts; accepting needs no reason and is recorded', async () => {
    const pending = (await view('pe')).pending[0]!;
    for (const who of ['tech', 'js', 'lm', 'lab'] as const) {
      expect((await decide(pending.id, 'accept', who)).status, who).toBe(403);
    }
    const accepted = await decide(pending.id, 'accept', 'pe');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(projectTeamJoinRequestsSchema.parse(accepted.body).pending).toEqual([]);
    expect((await view('tech')).mine).toMatchObject({
      status: 'accepted',
      decidedBy: { userId: h.users.pe },
    });
    expect(await items()).toEqual([{ status: 'resolved', resolution: 'accepted' }]);
    expect(await memberships(h.users.tech)).toEqual([true]);
    // An exact retry is fine; declining it now is a conflict.
    expect((await decide(pending.id, 'accept', 'pe')).status).toBe(200);
    expect((await decide(pending.id, 'decline', 'pe', { reason: 'No' })).status).toBe(409);
  });

  it('declining needs a reason, removes them and tells them; they may ask again', async () => {
    const first = projectTeamJoinRequestsSchema.parse((await join('js')).body).mine!;
    expect((await decide(first.id, 'decline', 'admin')).status).toBe(400);
    expect((await decide(first.id, 'decline', 'admin', { reason: ' ' })).status).toBe(400);
    const declined = await decide(first.id, 'decline', 'admin', {
      reason: 'Not working on this project',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(await memberships(h.users.js)).toEqual([false]);
    // They see the decline, who made it and why, and may ask again.
    expect(await view('js')).toMatchObject({
      canRequest: true,
      mine: {
        status: 'declined',
        decidedBy: { userId: h.users.admin },
        reason: 'Not working on this project',
      },
    });
    const audit = await listAuditForEntity(h.db.pool, 'project_team_join_request', first.id);
    expect(audit[0]).toMatchObject({
      action: 'project_team_join_request.declined',
      receiverUserId: h.users.js,
      reason: 'Not working on this project',
    });
    expect((await items()).at(-1)).toEqual({ status: 'resolved', resolution: 'declined' });

    const second = await join('js');
    expect(second.status).toBe(201);
    expect(projectTeamJoinRequestsSchema.parse(second.body).mine?.status).toBe('pending');
    expect(await memberships(h.users.js)).toEqual([false, true]);

    // Removing a pending member the ordinary way declines the request too.
    const pending = projectTeamJoinRequestsSchema.parse(second.body).mine!;
    const removed = await h
      .http()
      .delete(`/api/projects/${projectId}/team-members/${pending.teamMemberId}`)
      .set('Cookie', await h.cookie('pe'))
      .set('x-materialmule-csrf', '1')
      .send({ reason: 'Left the project' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await view('js')).mine).toMatchObject({
      status: 'declined',
      reason: 'Left the project',
    });
    expect((await items()).at(-1)).toEqual({ status: 'resolved', resolution: 'declined' });
  });

  it('joining grants no elevated authority', async () => {
    const caps = (await h.get(`/api/projects/${projectId}/capabilities`, 'tech')).body as {
      involvement: string[];
      capabilities: { action: string; allowed: boolean }[];
    };
    expect(caps.involvement).toEqual(['team_member']);
    expect(caps.capabilities.filter((c) => c.allowed)).toEqual([]);
  });
});
