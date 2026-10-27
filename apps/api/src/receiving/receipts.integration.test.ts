import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  confirmReceiptRequestSchema,
  confirmReceiptResponseSchema,
  type ConfirmReceiptRequestInput,
  type ConfirmReceiptResponse,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import type { AuthUser } from '../auth/policy.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertProject, insertTestHole, receivingLabId } from '../test-support/fixtures.js';
import { businessToday, ReceiptsService } from './receipts.service.js';

// Fictional data only: project DEMO-2601, test holes TH26-01 / TH26-02, receiver AT.
describe.runIf(testDatabaseUrl)('receipt confirmation API (MM-T09)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  let locationId: string;
  const users: Record<string, string> = {};
  let projectId: string;
  let th01: string;
  let th02: string;
  let otherProjectHole: string;

  async function addUser(
    key: string,
    name: string,
    initials: string | null,
    accountType: 'personal' | 'shared_lab' | 'test',
    status: 'pending' | 'active' | 'disabled' = 'active',
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, initials, accountType, status],
    );
    users[key] = rows[0]!.id;
  }

  async function cookieFor(key: string, issuedAt?: Date) {
    const accountType = key === 'lab' ? 'shared_lab' : 'personal';
    const session = await sessions.create(users[key]!, accountType, issuedAt);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  /** A two-bucket TH26-01 receipt (G1–S12 and G13–S32) with a fresh idempotency key. */
  function twoBuckets(overrides: Partial<ConfirmReceiptRequestInput> = {}) {
    return {
      idempotencyKey: randomUUID(),
      projectId,
      receivedDate: '2026-01-15',
      receiverUserId: users.at!,
      description: 'Two buckets from TH26-01',
      units: [
        {
          clientRowId: 'row-a',
          unitType: 'bucket',
          holeSummaries: [
            { testHoleId: th01, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
          ],
        },
        {
          clientRowId: 'row-b',
          unitType: 'bucket',
          note: 'Lid cracked',
          holeSummaries: [
            { testHoleId: th01, type: 'sample_range', sampleFrom: 'G13', sampleTo: 'S32' },
          ],
        },
      ],
      ...overrides,
    } satisfies ConfirmReceiptRequestInput;
  }

  async function post(body: unknown, cookie?: string) {
    return request(app.getHttpServer())
      .post('/api/receipts')
      .set('Cookie', cookie ?? (await cookieFor('lab')))
      .set(CSRF_HEADER, '1')
      .send(body as object);
  }

  /** Everything a confirmation can write, to prove a failed request changed nothing. */
  async function snapshot() {
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*) FROM receipt)::int AS receipts,
              (SELECT count(*) FROM storage_unit)::int AS units,
              (SELECT count(*) FROM storage_unit_hole_summary)::int AS summaries,
              (SELECT count(*) FROM audit_event)::int AS audits,
              (SELECT coalesce(json_agg(c ORDER BY prefix, year), '[]'::json)
                 FROM storage_unit_annual_counter c) AS counters`,
    );
    return rows[0] as Record<string, unknown>;
  }

  async function auditCount(entityIds: string[]) {
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event WHERE entity_id = ANY($1::uuid[])',
      [entityIds],
    );
    return rows[0]!.n;
  }

  const sequence = (suNumber: string) => Number(suNumber.split('-')[2]);

  beforeAll(async () => {
    db = await createMigratedSchema();
    locationId = await receivingLabId(db.pool);
    await addUser('lab', 'Lab (shared)', 'LAB', 'shared_lab');
    await addUser('at', 'Alex Tester', 'AT', 'personal');
    await addUser('pe', 'Pat Example', 'PE', 'personal');
    await addUser('gone', 'Former Staff', 'FS', 'personal', 'disabled');
    await addUser('pend', 'New Starter', null, 'personal', 'pending');
    await addUser('noinit', 'No Initials', null, 'personal');
    projectId = await insertProject(db.pool, 'DEMO-2601', users.pe!);
    th01 = await insertTestHole(db.pool, projectId, 'TH26-01');
    th02 = await insertTestHole(db.pool, projectId, 'TH26-02');
    const other = await insertProject(db.pool, 'DEMO-2602', users.pe!);
    otherProjectHole = await insertTestHole(db.pool, other, 'TH26-01');

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    // Listen once: parallel supertest requests on a non-listening server each call listen(0)
    // on the same server and can see a null address (flaky 'server.address() null').
    await app.listen(0, '127.0.0.1');
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('AC1 + AC6 (T3): LAB confirms two buckets for receiver AT', async () => {
    const body = twoBuckets();
    const response = await post(body);
    expect(response.status).toBe(201);
    const result = confirmReceiptResponseSchema.parse(response.body);

    expect(result.units.map((u) => u.clientRowId)).toEqual(['row-a', 'row-b']);
    const [first, second] = result.units.map((u) => u.suNumber);
    expect(first).toMatch(/^BKT-\d{4}-\d{6}$/);
    expect(second).toMatch(/^BKT-\d{4}-\d{6}$/);
    expect(sequence(second!)).toBe(sequence(first!) + 1);

    const { rows: receipts } = await db.pool.query(
      `SELECT quantity, account_user_id, receiver_user_id, receiver_initials_snapshot,
              receiver_name_snapshot, description, received_date::text AS received_date
       FROM receipt WHERE id = $1`,
      [result.receiptId],
    );
    expect(receipts[0]).toEqual({
      quantity: 2,
      account_user_id: users.lab,
      receiver_user_id: users.at,
      receiver_initials_snapshot: 'AT',
      receiver_name_snapshot: 'Alex Tester',
      description: 'Two buckets from TH26-01',
      received_date: '2026-01-15',
    });

    const { rows: units } = await db.pool.query(
      `SELECT id, readable_id, unit_type, holder_kind, id_prefix, current_location_id, status,
              note, receipt_line
       FROM storage_unit WHERE receipt_id = $1 ORDER BY receipt_line`,
      [result.receiptId],
    );
    expect(units).toEqual([
      expect.objectContaining({
        id: result.units[0]!.storageUnitId,
        readable_id: first,
        unit_type: 'bucket',
        holder_kind: 'bucket',
        id_prefix: 'BKT',
        current_location_id: locationId,
        status: 'in_stock',
        note: null,
        receipt_line: 1,
      }),
      expect.objectContaining({ readable_id: second, note: 'Lid cracked', receipt_line: 2 }),
    ]);

    const { rows: summaries } = await db.pool.query(
      `SELECT su.readable_id, s.summary_type, s.sample_from, s.sample_to
       FROM storage_unit_hole_summary s JOIN storage_unit su ON su.id = s.storage_unit_id
       WHERE su.receipt_id = $1 ORDER BY su.receipt_line`,
      [result.receiptId],
    );
    expect(summaries).toEqual([
      { readable_id: first, summary_type: 'sample_range', sample_from: 'G1', sample_to: 'S12' },
      { readable_id: second, summary_type: 'sample_range', sample_from: 'G13', sample_to: 'S32' },
    ]);

    const ids = [result.receiptId, ...result.units.map((u) => u.storageUnitId)];
    expect(await auditCount(ids)).toBe(3);
    const { rows: audits } = await db.pool.query(
      `SELECT action, actor_user_id, actor_account_type, actor_initials_snapshot, receiver_user_id
       FROM audit_event WHERE entity_id = ANY($1::uuid[]) ORDER BY action`,
      [ids],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'receipt.confirmed',
      'storage_unit.created',
      'storage_unit.created',
    ]);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        actor_user_id: users.lab,
        actor_account_type: 'shared_lab',
        actor_initials_snapshot: 'LAB',
        receiver_user_id: users.at,
      });
    }
  });

  it('AC7: a mixed-hole bucket becomes one unit with two summaries', async () => {
    const response = await post(
      twoBuckets({
        units: [
          {
            clientRowId: 'mixed',
            unitType: 'bucket',
            holeSummaries: [
              { testHoleId: th01, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
              { testHoleId: th02, type: 'all' },
            ],
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const result = confirmReceiptResponseSchema.parse(response.body);
    expect(result.units).toHaveLength(1);
    const { rows } = await db.pool.query(
      `SELECT th.name, s.summary_type FROM storage_unit_hole_summary s
       JOIN test_hole th ON th.id = s.test_hole_id
       WHERE s.storage_unit_id = $1 ORDER BY th.name`,
      [result.units[0]!.storageUnitId],
    );
    expect(rows).toEqual([
      { name: 'TH26-01', summary_type: 'sample_range' },
      { name: 'TH26-02', summary_type: 'all' },
    ]);
    const { rows: receipt } = await db.pool.query('SELECT quantity FROM receipt WHERE id = $1', [
      result.receiptId,
    ]);
    expect(receipt[0]).toEqual({ quantity: 1 });
  });

  it('AC2 (T4): a failure after the first unit insert leaves nothing behind', async () => {
    // Fail the second storage unit insert, i.e. after the first unit (and its summary) exist.
    await db.pool.query(`
      CREATE FUNCTION fail_second_unit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$;
      CREATE TRIGGER fail_second_unit BEFORE INSERT ON storage_unit
        FOR EACH ROW WHEN (NEW.receipt_line = 2) EXECUTE FUNCTION fail_second_unit();`);
    try {
      const before = await snapshot();
      const body = twoBuckets();
      const response = await post(body);
      expect(response.status).toBe(500);
      expect(await snapshot()).toEqual(before);
      const { rows } = await db.pool.query('SELECT 1 FROM receipt WHERE idempotency_key = $1', [
        body.idempotencyKey,
      ]);
      expect(rows).toEqual([]);
    } finally {
      await db.pool.query(
        'DROP TRIGGER fail_second_unit ON storage_unit; DROP FUNCTION fail_second_unit();',
      );
    }
  });

  it('AC3: the same request twice returns the original receipt and creates nothing new', async () => {
    const body = twoBuckets();
    const first = await post(body);
    expect(first.status).toBe(201);
    const afterFirst = await snapshot();

    const second = await post(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await snapshot()).toEqual(afterFirst);

    // A retry from another session (e.g. after signing in again) gets the same answer.
    const third = await post(body, await cookieFor('at'));
    expect(third.status).toBe(200);
    expect((third.body as ConfirmReceiptResponse).receiptId).toBe(
      (first.body as ConfirmReceiptResponse).receiptId,
    );
  });

  it('T5: parallel identical requests with one key create one receipt', async () => {
    const body = twoBuckets();
    const cookie = await cookieFor('lab');
    const responses = await Promise.all([
      post(body, cookie),
      post(body, cookie),
      post(body, cookie),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    for (const response of responses) {
      expect(response.body).toEqual(responses[0]!.body);
    }
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
       WHERE r.idempotency_key = $1`,
      [body.idempotencyKey],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('AC4 (T6): the same key with a changed payload returns 409 and changes nothing', async () => {
    const body = twoBuckets();
    expect((await post(body)).status).toBe(201);
    const before = await snapshot();

    const changed = { ...body, description: 'Three buckets, actually' };
    const response = await post(changed);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'idempotency_key_reused' });
    expect(await snapshot()).toEqual(before);
  });

  it('AC5: a test hole from another project returns 422 and changes nothing', async () => {
    const before = await snapshot();
    const body = twoBuckets();
    body.units[1]!.holeSummaries![0]!.testHoleId = otherProjectHole;
    const response = await post(body);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      code: 'test_hole_not_in_project',
      errors: [
        {
          field: 'units.1.holeSummaries.0.testHoleId',
          code: 'test_hole_not_in_project',
          message: expect.any(String),
        },
      ],
    });
    expect(await snapshot()).toEqual(before);
  });

  it('T7: an expired LAB session gets 401 and nothing is persisted', async () => {
    const before = await snapshot();
    const twoMonthsAgo = new Date(Date.now() - 62 * 24 * 60 * 60 * 1000);
    const response = await post(twoBuckets(), await cookieFor('lab', twoMonthsAgo));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'unauthenticated' });
    expect(await snapshot()).toEqual(before);
  });

  describe('ID year = confirmation date in America/Edmonton, never the received date (MM-T49)', () => {
    const lab = (): AuthUser => ({
      userId: users.lab!,
      sessionId: randomUUID(),
      accountType: 'shared_lab',
      status: 'active',
      roles: [],
      displayName: 'Lab (shared)',
      initials: 'LAB',
    });

    /** Confirms a TH26-01 bucket received on `receivedDate` with the clock at `now`. */
    async function confirmAt(receivedDate: string, now: Date) {
      const body = confirmReceiptRequestSchema.parse({
        ...twoBuckets({ receivedDate }),
        units: [twoBuckets().units[0]],
      });
      const result = await app.get(ReceiptsService).confirm(body, lab(), { now });
      expect(result.created).toBe(true);
      const { suNumber, storageUnitId } = result.response.units[0]!;
      const { rows } = await db.pool.query(
        `SELECT su.readable_id, su.id_prefix, su.issued_year, su.received_date::text AS received_date,
                r.received_date::text AS receipt_received_date, r.confirmed_at
         FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id WHERE su.id = $1`,
        [storageUnitId],
      );
      return { suNumber, row: rows[0] as Record<string, unknown> };
    }

    it('received 2026-12-20, confirmed 2027-01-03 → a 2027 ID', async () => {
      // 2027-01-03 11:00 in Edmonton (MST, UTC−7).
      const confirmedAt = new Date('2027-01-03T18:00:00Z');
      const { suNumber, row } = await confirmAt('2026-12-20', confirmedAt);
      expect(suNumber).toMatch(/^BKT-2027-\d{6}$/);
      expect(row).toEqual({
        readable_id: suNumber,
        id_prefix: 'BKT',
        issued_year: 2027,
        received_date: '2026-12-20',
        receipt_received_date: '2026-12-20',
        confirmed_at: confirmedAt,
      });
    });

    it('uses the Edmonton date, not UTC: 2027-01-01 05:30 UTC is still 2026 in Edmonton', async () => {
      // 2026-12-31 22:30 in Edmonton; already 2027 in UTC.
      const { suNumber, row } = await confirmAt('2026-12-20', new Date('2027-01-01T05:30:00Z'));
      expect(suNumber).toMatch(/^BKT-2026-\d{6}$/);
      expect(row).toMatchObject({ issued_year: 2026, received_date: '2026-12-20' });
    });
  });

  describe('validation (400 with field errors)', () => {
    async function expectFieldError(body: unknown, field: string, code: string) {
      const before = await snapshot();
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field, code, message: expect.any(String) }),
      );
      expect(await snapshot()).toEqual(before);
    }

    it('rejects a malformed payload with field paths', async () => {
      const body = twoBuckets();
      body.units[0]!.holeSummaries![0] = { testHoleId: th01, type: 'depth_range' } as never;
      await expectFieldError(body, 'units.0.holeSummaries.0.depthUnit', 'required');
      await expectFieldError({ ...twoBuckets(), units: [] }, 'units', 'too_small');
      await expectFieldError('not json', 'idempotencyKey', 'invalid_type');
    });

    it('rejects a received date in the future (business time zone)', async () => {
      await expectFieldError(
        twoBuckets({ receivedDate: '2999-01-01' }),
        'receivedDate',
        'in_future',
      );
      const today = businessToday(new Date(), 'America/Edmonton');
      expect((await post(twoBuckets({ receivedDate: today }))).status).toBe(201);
    });

    it('rejects an unknown project', async () => {
      await expectFieldError(twoBuckets({ projectId: randomUUID() }), 'projectId', 'not_found');
    });

    it('requires an active staff member as receiver, never LAB', async () => {
      await expectFieldError(
        twoBuckets({ receiverUserId: randomUUID() }),
        'receiverUserId',
        'not_found',
      );
      for (const key of ['gone', 'pend', 'lab']) {
        await expectFieldError(
          twoBuckets({ receiverUserId: users[key]! }),
          'receiverUserId',
          'receiver_not_active',
        );
      }
      await expectFieldError(
        twoBuckets({ receiverUserId: users.noinit! }),
        'receiverUserId',
        'receiver_missing_initials',
      );
    });

    it('caps a receipt at 50 units', async () => {
      const unit = twoBuckets().units[0]!;
      const units = Array.from({ length: 51 }, (_, i) => ({ ...unit, clientRowId: `r${i}` }));
      await expectFieldError(twoBuckets({ units }), 'units', 'too_big');
    });
  });

  describe('access', () => {
    it('requires a session and the CSRF header', async () => {
      const anonymous = await request(app.getHttpServer())
        .post('/api/receipts')
        .set(CSRF_HEADER, '1')
        .send(twoBuckets());
      expect(anonymous.status).toBe(401);

      const noCsrf = await request(app.getHttpServer())
        .post('/api/receipts')
        .set('Cookie', await cookieFor('lab'))
        .send(twoBuckets());
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toMatchObject({ code: 'csrf_header_missing' });
    });

    it('refuses pending accounts and allows active personal accounts', async () => {
      const pending = await post(twoBuckets(), await cookieFor('pend'));
      expect(pending.status).toBe(403);
      const personal = await post(twoBuckets(), await cookieFor('pe'));
      expect(personal.status).toBe(201);
      const { rows } = await db.pool.query(
        'SELECT account_user_id, receiver_user_id FROM receipt WHERE id = $1',
        [personal.body.receiptId],
      );
      expect(rows[0]).toEqual({ account_user_id: users.pe, receiver_user_id: users.at });
    });
  });
});

describe.runIf(testDatabaseUrl)('receipt unit limit is configurable', () => {
  it('applies RECEIPT_MAX_UNITS below the hard limit of 50', async () => {
    const db = await createMigratedSchema();
    try {
      await receivingLabId(db.pool);
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
         VALUES ('Alex Tester', 'AT', 'personal', 'active') RETURNING id`,
      );
      const userId = rows[0]!.id;
      const projectId = await insertProject(db.pool, 'DEMO-2601', userId);
      const hole = await insertTestHole(db.pool, projectId, 'TH26-01');
      const app = await createApp(
        loadConfig({
          APP_ENV: 'test',
          DATABASE_URL: databaseUrlForSchema(db.schema),
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
          LOG_LEVEL: 'silent',
          RECEIPT_MAX_UNITS: '1',
        }),
      );
      await app.init();
      // Listen once: parallel supertest requests on a non-listening server each call listen(0)
      // on the same server and can see a null address (flaky 'server.address() null').
      await app.listen(0, '127.0.0.1');
      try {
        const session = await app.get(SessionService).create(userId, 'personal');
        const unit = (clientRowId: string) => ({
          clientRowId,
          unitType: 'bucket',
          holeSummaries: [{ testHoleId: hole, type: 'all' }],
        });
        const response = await request(app.getHttpServer())
          .post('/api/receipts')
          .set('Cookie', `${SESSION_COOKIE}=${session.token}`)
          .set(CSRF_HEADER, '1')
          .send({
            idempotencyKey: randomUUID(),
            projectId,
            receivedDate: '2026-01-15',
            receiverUserId: userId,
            units: [unit('a'), unit('b')],
          });
        expect(response.status).toBe(400);
        expect(response.body.errors).toContainEqual(
          expect.objectContaining({ field: 'units', code: 'too_many_units' }),
        );
      } finally {
        await app.close();
      }
    } finally {
      await db.drop();
    }
  });
});
