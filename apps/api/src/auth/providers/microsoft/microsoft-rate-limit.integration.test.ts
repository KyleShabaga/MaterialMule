import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../config/env.js';
import { createApp } from '../../../create-app.js';
import { runSeed } from '../../../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../../../test-support/database.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_TENANT_ID,
  startMockOidc,
  type MockOidc,
} from '../../../test-support/mock-oidc.js';
import { CSRF_HEADER } from '../../auth.guard.js';
import { SESSION_COOKIE } from '../../session-cookie.js';
import { RATE_LIMITED_MESSAGE, SIGN_IN_BINDING_COOKIE } from './microsoft-auth.controller.js';
import { MICROSOFT_SIGN_IN_LIMIT, MicrosoftSignInRateLimit } from './microsoft-rate-limit.js';

const REDIRECT_URI = 'http://localhost:5173/sign-in/microsoft/callback';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// MM-T48: per-address rate limit on Microsoft sign-in, against the mock Entra tenant. Requests
// go out from two different loopback source addresses so the API sees two distinct clients.
describe.runIf(testDatabaseUrl)('Microsoft sign-in rate limit (MM-T48)', () => {
  const ONE = '127.0.0.1';
  const OTHER = '127.0.0.2';
  let db: TestSchema;
  let mock: MockOidc;
  let app: INestApplication;
  let port: number;

  function send(
    from: string,
    method: 'GET' | 'POST',
    path: string,
    options: { body?: object; cookie?: string[] } = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = options.body ? JSON.stringify(options.body) : undefined;
      const req = httpRequest(
        {
          host: ONE,
          port,
          method,
          path,
          localAddress: from,
          headers: {
            [CSRF_HEADER]: '1',
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...(options.cookie ? { cookie: options.cookie.join('; ') } : {}),
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  const start = (from: string) => send(from, 'GET', '/api/auth/microsoft/start?returnTo=%2F');
  const callback = (from: string, body: object = {}, cookie?: string[]) =>
    send(from, 'POST', '/api/auth/microsoft/callback', { body, cookie });

  async function auditCount(): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event',
    );
    return rows[0]!.n;
  }

  beforeAll(async () => {
    mock = await startMockOidc();
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        MICROSOFT_TENANT_ID: MOCK_TENANT_ID,
        MICROSOFT_CLIENT_ID: MOCK_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MICROSOFT_REDIRECT_URI: REDIRECT_URI,
        MICROSOFT_AUTHORITY_HOST: mock.url,
        MICROSOFT_GRAPH_BASE_URL: mock.url,
        BOOTSTRAP_ADMIN_OBJECT_ID: mock.users.get('avery')!.oid,
      }),
    );
    await app.listen(0, ONE);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  beforeEach(() => {
    app.get(MicrosoftSignInRateLimit).reset();
  });

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await db?.drop();
  });

  it('AC2: rapid sign-in starts from one address get 429; another address is unaffected', async () => {
    const audits = await auditCount();
    for (let i = 0; i < MICROSOFT_SIGN_IN_LIMIT; i += 1) {
      expect((await start(ONE)).status).toBe(302);
    }
    const refused = await start(ONE);
    expect(refused.status).toBe(429);
    expect(refused.headers['content-type']).toMatch(/^text\/plain/);
    expect(refused.body).toBe(RATE_LIMITED_MESSAGE);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(300);

    // A different client address still starts sign-in normally.
    expect((await start(OTHER)).status).toBe(302);
    // Denials are logged, not audited.
    expect(await auditCount()).toBe(audits);
  });

  it('AC2: rapid callbacks from one address get 429 with a plain message; another is unaffected', async () => {
    for (let i = 0; i < MICROSOFT_SIGN_IN_LIMIT; i += 1) {
      expect((await callback(ONE)).status).toBe(400); // malformed: refused, but counted
    }
    const refused = await callback(ONE);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBeDefined();
    expect((await callback(OTHER)).status).toBe(400);
  });

  it('AC3: a normal sign-in is unaffected', async () => {
    mock.autoSignIn('avery');
    mock.autoError(null);
    const begun = await start(ONE);
    expect(begun.status).toBe(302);
    const binding = (begun.headers['set-cookie'] as string[])
      .find((c) => c.startsWith(`${SIGN_IN_BINDING_COOKIE}=`))!
      .split(';')[0]!;
    const authorize = await fetch(begun.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    const done = await callback(
      ONE,
      { state: back.searchParams.get('state')!, code: back.searchParams.get('code')! },
      [binding],
    );
    expect(done.status).toBe(200);
    const cookies = done.headers['set-cookie'] as string[];
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });
});
