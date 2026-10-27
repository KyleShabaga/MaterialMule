import { randomUUID } from 'node:crypto';
import {
  receiptDetailSchema,
  receiptLogPageSchema,
  receiverListResponseSchema,
  type ConfirmReceiptResponse,
  type ReceiptLogPage,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { insertProject, insertTestHole } from '../test-support/fixtures.js';
import { ReceivingHarness } from '../test-support/receiving-harness.js';

// Receiving Log list and receipt detail (MM-T51, card tests T2–T5). Fictional data only:
// DEMO-2601 / DEMO-2602, TH26-01 / TH26-02, and two receivers who share the initials JS.
describe.runIf(testDatabaseUrl)('receiving log API (MM-T51)', () => {
  let h: ReceivingHarness;
  const cookies: Record<string, string> = {};
  const people: Record<string, string> = {};
  let otherProject: string;
  let otherHole: string;

  async function addUser(
    key: string,
    name: string,
    initials: string,
    status: 'pending' | 'active' = 'active',
  ) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
    people[key] = rows[0]!.id;
    const session = await h.app.get(SessionService).create(rows[0]!.id, 'personal');
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
  }

  async function confirm(
    count: number,
    overrides: Parameters<ReceivingHarness['receipt']>[1] = {},
    as: string = cookies.lab!,
  ): Promise<ConfirmReceiptResponse> {
    const response = await h.postReceipt(h.receipt(count, overrides), as);
    expect(response.status).toBe(201);
    return response.body as ConfirmReceiptResponse;
  }

  async function list(query: string, as: string = cookies.at!): Promise<ReceiptLogPage> {
    const response = await h.http().get(`/api/receipts${query}`).set('Cookie', as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return receiptLogPageSchema.parse(response.body);
  }

  async function detail(receiptId: string, as: string = cookies.at!) {
    const response = await h.http().get(`/api/receipts/${receiptId}`).set('Cookie', as);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return receiptDetailSchema.parse(response.body);
  }

  /** Everything a read could create by mistake. */
  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*) FROM receipt)::int AS receipts,
              (SELECT count(*) FROM storage_unit)::int AS units,
              (SELECT count(*) FROM print_job)::int AS print_jobs,
              (SELECT count(*) FROM audit_event)::int AS audits`,
    );
    return rows[0] as Record<string, number>;
  }

  beforeAll(async () => {
    h = await ReceivingHarness.boot();
    cookies.lab = await h.cookieFor('lab');
    cookies.at = await h.cookieFor('at');
    cookies.pe = await h.cookieFor('pe');
    await addUser('jordan', 'Jordan Smith', 'JS');
    await addUser('jamie', 'Jamie Sato', 'JS');
    await addUser('pending', 'New Starter', 'NS', 'pending');
    otherProject = await insertProject(h.db.pool, 'DEMO-2602', h.users.pe);
    otherHole = await insertTestHole(h.db.pool, otherProject, 'TH26-01');
  });

  afterAll(async () => {
    await h?.close();
  });

  it('AC1/AC7: one row per receipt with the header snapshot; a retried confirmation adds nothing', async () => {
    const body = h.receipt(2, { receivedDate: '2026-01-15', description: 'Two buckets' });
    const first = await h.postReceipt(body, cookies.lab!);
    expect(first.status).toBe(201);
    const receiptId = (first.body as ConfirmReceiptResponse).receiptId;
    // The same confirmation retried with its original idempotency key.
    const retry = await h.postReceipt(body, cookies.lab!);
    expect(retry.status).toBe(200);
    expect((retry.body as ConfirmReceiptResponse).receiptId).toBe(receiptId);

    const page = await list(`?search=${encodeURIComponent('Alex Tester')}`);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item).toMatchObject({
      id: receiptId,
      receivedDate: '2026-01-15',
      quantity: 2,
      project: { id: h.projectId, projectNumber: 'DEMO-2601' },
      receiver: { userId: h.users.at, initials: 'AT', name: 'Alex Tester' },
      // T8: the selected receiver, never the shared account that confirmed.
      account: { name: 'LAB', sharedStation: true },
    });
    expect(Date.parse(item.confirmedAt)).not.toBeNaN();
    // Explicit response fields: no idempotency key, request hash or raw columns.
    expect(Object.keys(item).sort()).toEqual(
      ['account', 'confirmedAt', 'id', 'project', 'quantity', 'receivedDate', 'receiver'].sort(),
    );
    expect(JSON.stringify(page)).not.toContain(body.idempotencyKey);

    const receipt = await detail(receiptId);
    expect(receipt.units.map((u) => u.readableId)).toEqual(
      (first.body as ConfirmReceiptResponse).units.map((u) => u.suNumber).sort(),
    );
    expect(receipt.description).toBe('Two buckets');
    expect(receipt.units[0]!.holes[0]).toMatchObject({ testHoleName: 'TH26-01', sampleFrom: 'G1' });
    expect(JSON.stringify(receipt)).not.toMatch(/idempotency|request_?hash/i);
    expect(JSON.stringify(receipt)).not.toContain(body.idempotencyKey);
  });

  it('AC4: receivers sharing initials are filtered by user ID and told apart by name', async () => {
    const jordan = await confirm(1, { receiverUserId: people.jordan!, receivedDate: '2026-02-02' });
    const jamie = await confirm(1, { receiverUserId: people.jamie!, receivedDate: '2026-02-03' });

    const onlyJordan = await list(`?receiverUserId=${people.jordan}`);
    expect(onlyJordan.items.map((r) => r.id)).toEqual([jordan.receiptId]);
    expect(onlyJordan.items[0]!.receiver).toEqual({
      userId: people.jordan,
      initials: 'JS',
      name: 'Jordan Smith',
    });

    // Searching by the shared initials finds both people's receipts.
    const byInitials = await list('?search=js');
    expect(byInitials.items.map((r) => r.id).sort()).toEqual(
      [jordan.receiptId, jamie.receiptId].sort(),
    );

    const options = receiverListResponseSchema.parse(
      (await h.http().get('/api/receipts/receivers?search=JS').set('Cookie', cookies.lab!)).body,
    );
    expect(options.map((o) => o.displayName).sort()).toEqual(['Jamie Sato', 'Jordan Smith']);
  });

  it('T3: a renamed or disabled receiver keeps the snapshot and stays findable by user ID', async () => {
    await addUser('casey', 'Casey Example', 'CE');
    const { receiptId } = await confirm(1, {
      receiverUserId: people.casey!,
      receivedDate: '2026-03-01',
    });
    await h.db.pool.query(
      `UPDATE app_user SET display_name = 'Casey Renamed', status = 'disabled' WHERE id = $1`,
      [people.casey],
    );

    const page = await list(`?receiverUserId=${people.casey}`);
    expect(page.items.map((r) => r.id)).toEqual([receiptId]);
    expect(page.items[0]!.receiver.name).toBe('Casey Example');
    // The old name still finds the receipt, from the snapshot.
    expect((await list('?search=casey%20example')).items.map((r) => r.id)).toEqual([receiptId]);

    // The filter can still offer them, by their current name.
    const byId = receiverListResponseSchema.parse(
      (await h.http().get(`/api/receipts/receivers?id=${people.casey}`).set('Cookie', cookies.at!))
        .body,
    );
    expect(byId).toEqual([
      { id: people.casey, initials: 'CE', displayName: 'Casey Renamed', position: null },
    ]);
    const byOldName = receiverListResponseSchema.parse(
      (await h.http().get('/api/receipts/receivers?search=example').set('Cookie', cookies.at!))
        .body,
    );
    expect(byOldName.map((o) => o.id)).toContain(people.casey);
    // Someone who never received anything isn't offered.
    const nobody = receiverListResponseSchema.parse(
      (
        await h
          .http()
          .get('/api/receipts/receivers?search=new%20starter')
          .set('Cookie', cookies.at!)
      ).body,
    );
    expect(nobody).toEqual([]);
  });

  it('AC5: corrected and disposed units stay listed under the original receipt header', async () => {
    const confirmed = await confirm(2, { receivedDate: '2026-04-10' });
    const [moved, disposed] = confirmed.units;
    const { rows } = await h.db.pool.query<{ version: number }>(
      'SELECT version FROM storage_unit WHERE id = $1',
      [moved!.storageUnitId],
    );
    const correction = await h
      .http()
      .patch(`/api/storage-units/${moved!.storageUnitId}`)
      .set('Cookie', cookies.at!)
      .set(CSRF_HEADER, '1')
      .send({
        version: rows[0]!.version,
        reason: 'Belongs to the second demo project',
        changes: {
          receivedDate: '2026-04-12',
          projectId: otherProject,
          holeSummaries: [{ testHoleId: otherHole, type: 'all' }],
        },
      });
    expect(correction.status, JSON.stringify(correction.body)).toBe(200);
    // No disposal workflow yet (MM-T29); set the status as that card will.
    await h.db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [
      disposed!.storageUnitId,
    ]);

    const receipt = await detail(confirmed.receiptId);
    expect(receipt).toMatchObject({
      receivedDate: '2026-04-10',
      project: { id: h.projectId, projectNumber: 'DEMO-2601' },
      quantity: 2,
    });
    const byId = new Map(receipt.units.map((u) => [u.id, u]));
    expect(byId.get(moved!.storageUnitId)).toMatchObject({
      receivedDate: '2026-04-12',
      project: { id: otherProject, projectNumber: 'DEMO-2602' },
      status: 'in_stock',
    });
    expect(byId.get(disposed!.storageUnitId)).toMatchObject({ status: 'disposed' });

    // Filters apply to the original header, not the corrected units.
    const original = await list(
      `?projectId=${h.projectId}&receivedFrom=2026-04-10&receivedTo=2026-04-10`,
    );
    expect(original.items.map((r) => r.id)).toEqual([confirmed.receiptId]);
    expect(original.items[0]!.quantity).toBe(2);
    expect((await list(`?projectId=${otherProject}`)).total).toBe(0);
    expect((await list('?receivedFrom=2026-04-11&receivedTo=2026-04-30')).total).toBe(0);
  });

  it('AC9: equal confirmation times page deterministically; a unit ID search returns its receipt once', async () => {
    const batch: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      batch.push((await confirm(3, { receivedDate: '2026-05-05', description: 'tie' })).receiptId);
    }
    await h.db.pool.query(
      `UPDATE receipt SET confirmed_at = '2026-05-05T15:00:00Z' WHERE id = ANY ($1::uuid[])`,
      [batch],
    );
    const filter = '?receivedFrom=2026-05-05&receivedTo=2026-05-05&pageSize=2';
    const pages = [
      await list(`${filter}&page=1`),
      await list(`${filter}&page=2`),
      await list(`${filter}&page=3`),
    ];
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
    const seen = pages.flatMap((p) => p.items.map((r) => r.id));
    // Ties break on receipt ID, descending, so no row repeats or goes missing.
    expect(seen).toEqual([...batch].sort().reverse());
    expect(pages.flatMap((p) => p.items.map((r) => r.quantity))).toEqual([3, 3, 3, 3, 3]);
    // Repeating a page returns the same rows.
    expect((await list(`${filter}&page=2`)).items).toEqual(pages[1]!.items);

    const { rows } = await h.db.pool.query<{ readable_id: string }>(
      `SELECT readable_id FROM storage_unit WHERE receipt_id = $1 ORDER BY readable_id LIMIT 1`,
      [batch[2]],
    );
    const byUnit = await list(
      `?search=${encodeURIComponent(` ${rows[0]!.readable_id.toLowerCase()} `)}`,
    );
    expect(byUnit.items.map((r) => r.id)).toEqual([batch[2]]);
    expect(byUnit.total).toBe(1);
  });

  it('AC3: search and project, date and receiver filters combine', async () => {
    const match = await confirm(1, { receivedDate: '2026-06-10' });
    await confirm(1, { receivedDate: '2026-06-20' });
    await confirm(1, { receivedDate: '2026-06-10', receiverUserId: people.jamie! });
    const page = await list(
      `?search=demo-2601&projectId=${h.projectId}&receiverUserId=${h.users.at}` +
        '&receivedFrom=2026-06-01&receivedTo=2026-06-15',
    );
    expect(page.items.map((r) => r.id)).toEqual([match.receiptId]);
    // Every word must match (AND): project number plus receiver name.
    expect(
      (await list('?search=demo-2601%20alex&receivedFrom=2026-06-10&receivedTo=2026-06-10')).total,
    ).toBe(1);
    expect(
      (await list('?search=demo-2602%20alex&receivedFrom=2026-06-10&receivedTo=2026-06-10')).total,
    ).toBe(0);
  });

  it('lists newest confirmation first and reports totals for paging', async () => {
    const all = await list('?pageSize=100');
    const times = all.items.map((r) => Date.parse(r.confirmedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.total).toBe(all.items.length);
    const { rows } = await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM receipt');
    expect(all.total).toBe(rows[0]!.n);
  });

  it('AC8/T5: reading the log, a receipt and its label previews creates nothing', async () => {
    const { receiptId, units } = await confirm(2, { receivedDate: '2026-07-01' });
    const before = await counts();
    for (let i = 0; i < 3; i += 1) {
      await list('');
      await detail(receiptId, cookies.lab!);
      expect(
        (
          await h
            .http()
            .get(`/api/receipts/${receiptId}/labels/preview`)
            .set('Cookie', cookies.lab!)
        ).status,
      ).toBe(200);
      expect(
        (
          await h
            .http()
            .get(`/api/storage-units/${units[0]!.storageUnitId}/label/preview`)
            .set('Cookie', cookies.lab!)
        ).status,
      ).toBe(200);
      await h.http().get('/api/receipts/receivers?search=a').set('Cookie', cookies.lab!);
    }
    expect(await counts()).toEqual(before);
  });

  it('AC10: invalid queries answer 400 with field errors; an unknown receipt 404', async () => {
    const bad = await h
      .http()
      .get('/api/receipts?receivedFrom=2026-02-30&pageSize=500&receiverUserId=JS')
      .set('Cookie', cookies.at!);
    expect(bad.status).toBe(400);
    const body = bad.body as { code: string; errors: { field: string }[] };
    expect(body.code).toBe('validation_failed');
    expect(body.errors.map((e) => e.field).sort()).toEqual([
      'pageSize',
      'receivedFrom',
      'receiverUserId',
    ]);

    const reversed = await h
      .http()
      .get('/api/receipts?receivedFrom=2026-02-02&receivedTo=2026-02-01')
      .set('Cookie', cookies.at!);
    expect(reversed.status).toBe(400);

    const notUuid = await h.http().get('/api/receipts/not-a-receipt').set('Cookie', cookies.at!);
    expect(notUuid.status).toBe(400);
    const unknown = await h.http().get(`/api/receipts/${randomUUID()}`).set('Cookie', cookies.at!);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'receipt_not_found' });
  });

  it('AC6/T4: LAB and personal accounts read; others are refused without receipt data', async () => {
    const { receiptId, units } = await confirm(1, { receivedDate: '2026-08-01' });
    await list('', cookies.lab!);
    await detail(receiptId, cookies.lab!);
    await detail(receiptId, cookies.pe!);

    const paths = ['/api/receipts', `/api/receipts/${receiptId}`, '/api/receipts/receivers'];
    for (const path of paths) {
      const anonymous = await h.http().get(path);
      expect(anonymous.status, path).toBe(401);
      const pending = await h.http().get(path).set('Cookie', cookies.pending!);
      expect(pending.status, path).toBe(403);
      for (const refused of [anonymous, pending]) {
        expect(JSON.stringify(refused.body)).not.toContain(receiptId);
        expect(JSON.stringify(refused.body)).not.toContain('Alex Tester');
      }
    }

    // LAB still can't correct a unit it can see on a receipt.
    const correction = await h
      .http()
      .patch(`/api/storage-units/${units[0]!.storageUnitId}`)
      .set('Cookie', cookies.lab!)
      .set(CSRF_HEADER, '1')
      .send({ version: 1, reason: 'not allowed for LAB', changes: { note: 'x' } });
    expect(correction.status).toBe(403);
  });
});
