import {
  inboxPageSchema,
  notificationListSchema,
  type InboxUpdateItem,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-133 (Kyle 2026-11-16): when a retention hold is released, the person it was for (the
// requester when it came from a retention request, else the placer) gets one "hold released"
// notice, never the releaser. Through the real API. Fictional data only: DEMO-2601 (Lead Project
// Engineer Pat Example `pe`), Lee Manager (`lm`, Lab Manager), Alex Tester (`tech`), Jordan Smith
// (`js`).
describe.runIf(testDatabaseUrl)('hold released notices (STRATA-133)', () => {
  let h: LabHarness;
  type As = Parameters<LabHarness['send']>[3];

  beforeAll(async () => {
    h = await createLabHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  const unit = () => h.bucket({ hole: h.holes.a1 });

  async function placeHold(body: Record<string, unknown>, as: As) {
    const placed = await h.send(
      'post',
      '/api/retention/holds',
      {
        projectId: h.projects.a,
        scope: 'project',
        reason: 'Claim review',
        idempotencyKey: newKey(),
        ...body,
      },
      as,
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    return placed.body as { id: string; version: number };
  }

  const release = (id: string, version: number, as: As, key = newKey()) =>
    h.send(
      'post',
      `/api/retention/holds/${id}/release`,
      { reason: 'Claim settled', version, idempotencyKey: key },
      as,
    );

  async function inboxUpdates(as: As): Promise<InboxUpdateItem[]> {
    const response = await h.get('/api/inbox?tab=updates', as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return inboxPageSchema
      .parse(response.body)
      .items.filter(
        (item): item is InboxUpdateItem =>
          item.type === 'update' && item.kind === 'retention_hold.released',
      );
  }

  const noticesFor = async (holdId: string) =>
    (
      await h.db.pool.query<{ recipient_user_id: string }>(
        `SELECT recipient_user_id FROM notification
         WHERE kind = 'retention_hold.released' AND retention_hold_id = $1`,
        [holdId],
      )
    ).rows.map((row) => row.recipient_user_id);

  it('tells the placer, with the unit, project and who released it, and opens the unit drawer', async () => {
    const one = await unit();
    const hold = await placeHold({ scope: 'units', unitIds: [one.id] }, 'lm');
    const released = await release(hold.id, hold.version, 'pe');
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(await noticesFor(hold.id)).toEqual([h.users.lm]);

    const [item] = (await inboxUpdates('lm')).filter((i) => i.title.includes(one.readableId));
    expect(item).toMatchObject({
      task: 'Hold released',
      title: `Hold released on ${one.readableId}`,
      jobNumber: 'DEMO-2601',
      projectId: h.projects.a,
      record: { kind: 'storage_unit', id: one.readableId, label: one.readableId },
      from: { userId: h.users.pe, name: 'Pat Example' },
      href: `/sample-storage?open=${one.readableId}`,
      unread: true,
      domain: 'retention',
      detail: 'Pat Example released the hold you placed: Claim settled',
    });

    // The older notification list renders it too, with the hold read live.
    const listed = notificationListSchema
      .parse((await h.get('/api/notifications', 'lm')).body)
      .items.find((n) => n.linkedHold?.id === hold.id);
    expect(listed).toMatchObject({
      kind: 'retention_hold.released',
      title: `Hold released on ${one.readableId}`,
      projectNumber: 'DEMO-2601',
      linkedHold: {
        scope: 'units',
        unitIds: [one.readableId],
        releasedBy: { name: 'Pat Example' },
        releaseReason: 'Claim settled',
        requested: false,
      },
    });
  });

  it('a requested hold tells the requester, not the decider who placed it', async () => {
    const one = await unit();
    const asked = await h.send(
      'post',
      '/api/retention/requests',
      {
        kind: 'hold',
        projectId: h.projects.a,
        scope: 'units',
        unitIds: [one.id],
        reason: 'Client may dispute',
        idempotencyKey: newKey(),
      },
      'tech',
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const approved = await h.send(
      'post',
      `/api/retention/requests/${asked.body.requestId}/approve`,
      { idempotencyKey: newKey() },
      'lm',
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const { rows } = await h.db.pool.query<{ id: string; version: number }>(
      'SELECT id, version FROM retention_hold WHERE request_id = $1',
      [asked.body.requestId],
    );
    const hold = rows[0]!;
    expect((await release(hold.id, hold.version, 'pe')).status).toBe(200);
    expect(await noticesFor(hold.id)).toEqual([h.users.tech]);
    const [item] = (await inboxUpdates('tech')).filter((i) => i.title.includes(one.readableId));
    expect(item).toMatchObject({
      aboutMyRequest: true,
      detail: 'Pat Example released the hold you asked for: Claim settled',
    });
    expect((await inboxUpdates('lm')).filter((i) => i.title.includes(one.readableId))).toHaveLength(
      0,
    );
  });

  it('releasing your own hold sends you nothing', async () => {
    const hold = await placeHold({}, 'lm');
    expect((await release(hold.id, hold.version, 'lm')).status).toBe(200);
    expect(await noticesFor(hold.id)).toEqual([]);
  });

  it('a project-wide hold names the project and opens its retention section', async () => {
    const hold = await placeHold({}, 'pe');
    expect((await release(hold.id, hold.version, 'lm')).status).toBe(200);
    const items = await inboxUpdates('pe');
    expect(items.find((i) => i.href.endsWith('#retention'))).toMatchObject({
      title: 'Hold released on DEMO-2601 · whole project',
      record: { kind: 'project', id: h.projects.a, label: 'DEMO-2601' },
      href: `/projects/${h.projects.a}#retention`,
      from: { name: 'Lee Manager' },
    });
  });

  it('a retried or concurrent release sends one notice', async () => {
    const retried = await placeHold({}, 'lm');
    const key = newKey();
    expect((await release(retried.id, retried.version, 'pe', key)).status).toBe(200);
    expect((await release(retried.id, retried.version, 'pe', key)).status).toBe(200);
    expect(await noticesFor(retried.id)).toEqual([h.users.lm]);

    const raced = await placeHold({}, 'lm');
    const results = await Promise.all([
      release(raced.id, raced.version, 'pe'),
      release(raced.id, raced.version, 'pe'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await noticesFor(raced.id)).toEqual([h.users.lm]);
  });

  it('no one else sees it or can change it, and LAB never reads it', async () => {
    const hold = await placeHold({}, 'lm');
    expect((await release(hold.id, hold.version, 'pe')).status).toBe(200);
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM notification WHERE retention_hold_id = $1`,
      [hold.id],
    );
    const id = rows[0]!.id;
    for (const who of ['pe', 'tech', 'js'] as const) {
      const theirs = notificationListSchema.parse((await h.get('/api/notifications', who)).body);
      expect(
        theirs.items.some((n) => n.id === id),
        who,
      ).toBe(false);
      expect(
        (await inboxUpdates(who)).some((i) => i.sourceId === id),
        who,
      ).toBe(false);
      expect((await h.send('post', `/api/notifications/${id}/read`, {}, who)).status, who).toBe(
        404,
      );
    }
    expect((await h.get('/api/inbox', 'lab')).status).toBe(403);
    expect((await h.get('/api/notifications', 'lab')).status).toBe(403);
    expect((await h.send('post', `/api/notifications/${id}/read`, {}, 'lm')).status).toBe(200);
  });
});
