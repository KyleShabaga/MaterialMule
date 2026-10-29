import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { ConfirmReceiptRequestInput } from '@materialmule/shared';
import request from 'supertest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed } from '../db/seed.js';
import { createMigratedSchema, databaseUrlForSchema, type TestSchema } from './database.js';
import { insertProject, insertTestHole } from './fixtures.js';

// A listening API on its own schema with fictional receiving data (MM-T18 concurrency and
// failure-injection tests): the reference seed (LAB, Receiving lab), receiver AT, Lead Project Engineer PE and
// project DEMO-2601 with TH26-01 and TH26-02. stop() and start() simulate the API process going
// away and coming back on the same database.

export const LAB_ID = '00000000-0000-4000-8000-000000000001';

export class ReceivingHarness {
  app!: INestApplication;
  /** http://127.0.0.1:<port> of the listening API. */
  baseUrl = '';

  private constructor(
    readonly db: TestSchema,
    readonly projectId: string,
    readonly holes: { th01: string; th02: string },
    readonly users: { at: string; pe: string },
    private readonly configOverrides: Record<string, string>,
  ) {}

  static async boot(configOverrides: Record<string, string> = {}): Promise<ReceivingHarness> {
    const db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    const addUser = async (name: string, initials: string) => {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
         VALUES ($1, $2, 'personal', 'active') RETURNING id`,
        [name, initials],
      );
      return rows[0]!.id;
    };
    const users = {
      at: await addUser('Alex Tester', 'AT'),
      pe: await addUser('Pat Example', 'PE'),
    };
    const projectId = await insertProject(db.pool, 'DEMO-2601', users.pe);
    const holes = {
      th01: await insertTestHole(db.pool, projectId, 'TH26-01'),
      th02: await insertTestHole(db.pool, projectId, 'TH26-02'),
    };
    const harness = new ReceivingHarness(db, projectId, holes, users, configOverrides);
    await harness.start();
    return harness;
  }

  /** Boots the API (and its print worker) against the harness database. */
  async start(): Promise<void> {
    this.app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(this.db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        ...this.configOverrides,
      }),
    );
    // Listen once, so dozens of parallel requests share one server (supertest would otherwise
    // bind an ephemeral server per request).
    await this.app.listen(0, '127.0.0.1');
    const { port } = this.app.getHttpServer().address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** Shuts the API down; the database (sessions included) stays. */
  async stop(): Promise<void> {
    await this.app.close();
  }

  /** A session cookie for LAB or a personal account. */
  async cookieFor(who: 'lab' | 'at' | 'pe'): Promise<string> {
    const sessions = this.app.get(SessionService);
    const session =
      who === 'lab'
        ? await sessions.create(LAB_ID, 'shared_lab')
        : await sessions.create(this.users[who], 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  /** A receipt of `count` buckets (TH26-01, unit i summarised G(10i+1)–S(10i+9)). */
  receipt(
    count: number,
    overrides: Partial<ConfirmReceiptRequestInput> = {},
  ): ConfirmReceiptRequestInput {
    return {
      idempotencyKey: randomUUID(),
      projectId: this.projectId,
      receivedDate: '2026-01-15',
      receiverUserId: this.users.at,
      description: null,
      units: Array.from({ length: count }, (_, i) => ({
        clientRowId: `row-${i + 1}`,
        unitType: 'bucket' as const,
        holeSummaries: [
          {
            testHoleId: this.holes.th01,
            type: 'sample_range' as const,
            sampleFrom: `G${i * 10 + 1}`,
            sampleTo: `S${i * 10 + 9}`,
          },
        ],
      })),
      ...overrides,
    };
  }

  http() {
    return request(this.baseUrl);
  }

  postReceipt(body: unknown, cookie: string) {
    return this.http()
      .post('/api/receipts')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);
  }

  /** Everything a confirmation writes, to prove a failed one changed nothing. */
  async snapshot(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.pool.query(
      `SELECT (SELECT count(*) FROM receipt)::int AS receipts,
              (SELECT count(*) FROM storage_unit)::int AS units,
              (SELECT count(*) FROM storage_unit_hole_summary)::int AS summaries,
              (SELECT count(*) FROM audit_event)::int AS audits,
              (SELECT coalesce(json_agg(c ORDER BY prefix, year), '[]'::json)
                 FROM storage_unit_annual_counter c) AS counters`,
    );
    return rows[0] as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.app?.close();
    await this.db.drop();
  }
}

export const bootReceivingHarness = (configOverrides?: Record<string, string>) =>
  ReceivingHarness.boot(configOverrides);
