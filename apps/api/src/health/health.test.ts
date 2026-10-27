import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@materialmule/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

function testConfig(databaseUrl: string) {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET,
    LOG_LEVEL: 'silent',
  });
}

// A real database is required in CI (REQUIRE_DATABASE_TESTS=1); locally the test is skipped,
// with a message, until TEST_DATABASE_URL points at a PostgreSQL test database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl && process.env.REQUIRE_DATABASE_TESTS === '1') {
  throw new Error('REQUIRE_DATABASE_TESTS=1 but TEST_DATABASE_URL is not set.');
}

describe('GET /api/health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports the database as down with HTTP 503 when PostgreSQL is unreachable', async () => {
    // Port 1 on loopback refuses connections immediately.
    app = await createApp(testConfig('postgres://nobody:nopw@127.0.0.1:1/nothing'));
    await app.init();

    const response = await request(app.getHttpServer()).get('/api/health');

    expect(response.status).toBe(503);
    const body = healthResponseSchema.parse(response.body);
    expect(body).toMatchObject({ status: 'degraded', database: 'down' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(response.body)).not.toContain('nopw');
  });

  it('returns a request ID header', async () => {
    app = await createApp(testConfig('postgres://nobody:nopw@127.0.0.1:1/nothing'));
    await app.init();

    const response = await request(app.getHttpServer())
      .get('/api/health')
      .set('x-request-id', 'trace-12345678');

    expect(response.headers['x-request-id']).toBe('trace-12345678');
  });

  it.runIf(testDatabaseUrl)('reports ok with HTTP 200 when PostgreSQL is reachable', async () => {
    app = await createApp(testConfig(testDatabaseUrl!));
    await app.init();

    const response = await request(app.getHttpServer()).get('/api/health');

    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(response.body)).toMatchObject({
      status: 'ok',
      database: 'up',
    });
  });
});
