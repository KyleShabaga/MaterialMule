import type { INestApplication } from '@nestjs/common';
import type { ConfirmReceiptResponse } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed } from '../db/seed.js';
import { withTransaction } from '../db/transaction.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { BENCH_PROFILES, generateBenchData } from './generate.js';
import { SeededRandom } from './random.js';
import { datasetFingerprint, tableCounts, verifyIntegrity } from './verify.js';
import { BENCH_RECEIVER_ID, loadTargets, receiptRequest } from './workload.js';

// MM-T19 test plan T3: the generator produces consistent, reproducible fictional data, and
// concurrent receipt confirmations on top of it never duplicate an ID or skip authorization.
describe.runIf(testDatabaseUrl)('benchmark dataset and post-load checks (MM-T19)', () => {
  const schemas: TestSchema[] = [];
  let app: INestApplication;
  let db: TestSchema;

  async function seededSchema(): Promise<TestSchema> {
    const schema = await createMigratedSchema();
    schemas.push(schema);
    await runSeed(schema.pool, 'reference', 'test');
    await runSeed(schema.pool, 'dev', 'test');
    await withTransaction(schema.pool, (client) =>
      generateBenchData(client, { profile: BENCH_PROFILES.tiny!, seed: 42, asOf: '2026-10-25' }),
    );
    return schema;
  }

  beforeAll(async () => {
    db = await seededSchema();
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    // Listen once, so the parallel requests below share one server instead of one each.
    await app.listen(0, '127.0.0.1');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const schema of schemas) await schema.drop();
  });

  it('generates the tiny profile consistently', async () => {
    const counts = await tableCounts(db.pool);
    // The dev fixtures add 5 units and 2 receipts of their own.
    expect(counts.storage_unit).toBe(BENCH_PROFILES.tiny!.units + 5);
    expect(counts.storage_unit_search).toBe(counts.storage_unit);
    expect(counts.audit_event).toBe(BENCH_PROFILES.tiny!.auditEvents);
    expect(counts.print_job).toBe(BENCH_PROFILES.tiny!.printJobs);
    expect((await verifyIntegrity(db.pool)).problems).toEqual([]);
  });

  it('reproduces the same rows from the same seed', async () => {
    const again = await seededSchema();
    expect(await datasetFingerprint(again.pool)).toBe(await datasetFingerprint(db.pool));
  }, 120_000);

  it('T3: parallel receipts issue unique, gap-free IDs and refusals stay refusals', async () => {
    const since = (await db.pool.query<{ now: Date }>('SELECT now()')).rows[0]!.now;
    const session = await app.get(SessionService).create(BENCH_RECEIVER_ID, 'personal');
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    const targets = await loadTargets(db.pool);
    const random = new SeededRandom(7);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' }).format(
      new Date(),
    );
    const server = app.getHttpServer();

    const confirmations = Array.from({ length: 12 }, () => {
      const planned = receiptRequest(random, targets, today);
      return request(server)
        .post('/api/receipts')
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .set('content-type', 'application/json')
        .send(planned.body!);
    });
    const refusals = [
      request(server).get('/api/inventory'),
      request(server)
        .post('/api/receipts')
        .set(CSRF_HEADER, '1')
        .send(JSON.parse(receiptRequest(random, targets, today).body!) as object),
      request(server).get('/api/staff').set('Cookie', cookie),
    ];
    const responses = await Promise.all([...confirmations, ...refusals]);

    const created = responses.slice(0, 12);
    expect(created.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(responses.slice(12).map((r) => r.status)).toEqual([401, 401, 403]);
    const ids = created.flatMap((r) =>
      (r.body as ConfirmReceiptResponse).units.map((u) => u.suNumber),
    );
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);

    const report = await verifyIntegrity(db.pool, since);
    expect(report.problems).toEqual([]);
    expect(report.receiptsSince).toBe(12);
    expect(report.unitsSince).toBe(60);
  }, 60_000);
});
