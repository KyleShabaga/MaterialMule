import {
  PROJECT_ACCESS_HISTORY_PAGE_SIZE,
  projectAccessHistorySchema,
  projectDetailSchema,
  projectTeamSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { insertProject } from '../test-support/fixtures.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';
import { testDatabaseUrl } from '../test-support/database.js';

// STRATA-85: Team & permissions › History, paged on the server. Real PostgreSQL, direct API
// calls. Fictional data only: a fresh project led by Pat Example (`pe`); Jordan (`js`) joins and
// leaves the team several times, Jamie (`jo`) becomes acceptance delegate, then an admin hands
// the project to Lee Manager (`lm`).
describe.runIf(testDatabaseUrl)('Team & permissions history (STRATA-85)', () => {
  let h: LabHarness;
  let projectId: string;
  type As = Parameters<LabHarness['send']>[3];

  const history = async (query = '', as: As = 'tech') => {
    const response = await h.get(`/api/projects/${projectId}/access-history${query}`, as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return projectAccessHistorySchema.parse(response.body);
  };
  const remove = async (memberId: string, reason: string) => {
    const response = await h
      .http()
      .delete(`/api/projects/${projectId}/team-members/${memberId}`)
      .set('Cookie', await h.cookie('pe'))
      .set(CSRF_HEADER, '1')
      .send({ reason });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };

  beforeAll(async () => {
    h = await createLabHarness();
    projectId = await insertProject(h.db.pool, 'S85-001', h.users.pe);
    // 11 add/remove pairs for Jordan: 22 events, more than one page.
    for (let i = 1; i <= 11; i++) {
      const added = await h.send(
        'post',
        `/api/projects/${projectId}/team-members`,
        { userId: h.users.js, reason: `Round ${i}`, idempotencyKey: newKey() },
        'pe',
      );
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const member = projectTeamSchema.parse(added.body).active[0]!;
      await remove(member.id, `Done with round ${i}`);
    }
    const delegate = await h.send(
      'post',
      `/api/projects/${projectId}/acceptance-delegates`,
      { delegateUserId: h.users.jo, reason: 'Covers acceptance', idempotencyKey: newKey() },
      'pe',
    );
    expect(delegate.status, JSON.stringify(delegate.body)).toBe(201);
    const version = projectDetailSchema.parse(
      (await h.get(`/api/projects/${projectId}`, 'admin')).body,
    ).version;
    const changed = await h.send(
      'patch',
      `/api/projects/${projectId}`,
      { version, leadProjectEngineerId: h.users.lm, reason: 'Pat moved to another office' },
      'admin',
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('lists every start and end newest first, with who and why, a page at a time', async () => {
    const first = await history();
    expect(first.pageSize).toBe(PROJECT_ACCESS_HISTORY_PAGE_SIZE);
    // 22 team events, the delegate grant and the lead change.
    expect(first.total).toBe(24);
    expect(first.events).toHaveLength(PROJECT_ACCESS_HISTORY_PAGE_SIZE);
    const at = first.events.map((e) => e.at);
    expect([...at].sort().reverse()).toEqual(at);
    expect(first.events[0]).toMatchObject({
      kind: 'lead_appointed',
      subject: { userId: h.users.lm, name: 'Lee Manager' },
      by: { userId: h.users.admin },
      reason: 'Pat moved to another office',
    });
    expect(first.events[1]).toMatchObject({
      kind: 'delegate_granted',
      subject: { userId: h.users.jo, name: 'Jamie Song' },
      by: { userId: h.users.pe, initials: 'PE', name: 'Pat Example' },
      reason: 'Covers acceptance',
    });
    expect(first.events[2]).toMatchObject({
      kind: 'team_member_removed',
      subject: { userId: h.users.js },
      reason: 'Done with round 11',
    });

    const second = await history('?page=2');
    expect(second.page).toBe(2);
    expect(second.events).toHaveLength(4);
    expect(second.events.at(-1)).toMatchObject({ kind: 'team_member_added', reason: 'Round 1' });
    const ids = new Set([...first.events, ...second.events].map((e) => e.id));
    expect(ids.size).toBe(24);

    const past = await history('?page=9');
    expect(past).toMatchObject({ total: 24, events: [] });
  });

  it('narrows to one person: events about them or recorded by them', async () => {
    const jamie = await history(`?userId=${h.users.jo}`);
    expect(jamie.total).toBe(1);
    expect(jamie.events.map((e) => e.kind)).toEqual(['delegate_granted']);
    const lee = await history(`?userId=${h.users.lm}`);
    expect(lee.events.map((e) => e.kind)).toEqual(['lead_appointed']);
  });

  it('is for personal accounts; refuses a bad page and an unknown project', async () => {
    expect((await h.get(`/api/projects/${projectId}/access-history`, 'lab')).status).toBe(403);
    expect((await h.get(`/api/projects/${projectId}/access-history?page=0`, 'tech')).status).toBe(
      400,
    );
    expect(
      (await h.get(`/api/projects/${projectId}/access-history?userId=nobody`, 'tech')).status,
    ).toBe(400);
    expect(
      (await h.get('/api/projects/00000000-0000-4000-8000-00000000ffff/access-history', 'tech'))
        .status,
    ).toBe(404);
  });
});
