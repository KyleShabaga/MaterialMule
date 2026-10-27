import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testAuthEnabled } from '../auth/test-provider/gating.js';
import { ConfigError, loadConfig, type AppConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed, SeedRefusedError } from '../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  canMakeTestCertificates,
  makeTestCertificate,
  type TestCertificate,
} from '../test-support/self-signed-cert.js';

// MM-T18 security suite: the development/test-only sign-in (MM-T33) can't be reached with a
// production configuration, however the environment is set. Fictional values only.

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

describe('security: test sign-in is refused in production (MM-T33 via T18)', () => {
  it('a production config with ENABLE_TEST_AUTH=true is refused at startup, naming only the key', () => {
    const env = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://nobody:not-a-real-password@127.0.0.1:1/nothing',
      SESSION_SECRET,
      ENABLE_TEST_AUTH: 'true',
      TLS_PFX_FILE: 'C:/nowhere/fictional.pfx',
    };
    let error: unknown;
    try {
      loadConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toContain(
      'ENABLE_TEST_AUTH must not be true when APP_ENV is production',
    );
    expect((error as ConfigError).message).not.toContain('not-a-real-password');
    expect((error as ConfigError).message).not.toContain(SESSION_SECRET);
  });

  it('even a hand-built production config object never enables the test provider', () => {
    const forged = { APP_ENV: 'production', ENABLE_TEST_AUTH: true } as AppConfig;
    expect(testAuthEnabled(forged)).toBe(false);
  });

  it.runIf(testDatabaseUrl)(
    'the fictional development seed refuses a production database',
    async () => {
      const db = await createMigratedSchema();
      try {
        await expect(runSeed(db.pool, 'dev', 'production')).rejects.toBeInstanceOf(
          SeedRefusedError,
        );
        const { rows } = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app_user WHERE account_type = 'test'`,
        );
        expect(rows[0]!.n).toBe(0);
      } finally {
        await db.drop();
      }
    },
  );

  describe.runIf(testDatabaseUrl && canMakeTestCertificates())('a running production API', () => {
    let db: TestSchema;
    let app: INestApplication;
    let cert: TestCertificate;
    let ca: Buffer;

    beforeAll(async () => {
      db = await createMigratedSchema();
      await runSeed(db.pool, 'reference', 'production');
      cert = makeTestCertificate();
      ca = readFileSync(cert.certFile);
      // Production must serve HTTPS (MM-T20), so it gets a throwaway localhost certificate.
      app = await createApp(
        loadConfig({
          APP_ENV: 'production',
          DATABASE_URL: databaseUrlForSchema(db.schema),
          SESSION_SECRET,
          LOG_LEVEL: 'silent',
          TLS_CERT_FILE: cert.certFile,
          TLS_KEY_FILE: cert.keyFile,
        }),
      );
      await app.init();
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await db?.drop();
      cert?.remove();
    });

    it('has no fixture sign-in routes, reports none, and creates no session', async () => {
      const server = app.getHttpServer();
      const fixtures = await request(server).get('/api/auth/test/fixtures').ca(ca);
      expect(fixtures.status).toBe(404);
      for (const fixtureKey of ['admin', 'lab', 'at']) {
        const signIn = await request(server)
          .post('/api/auth/test/sign-in')
          .ca(ca)
          .set(CSRF_HEADER, '1')
          .send({ fixtureKey });
        expect(signIn.status).toBe(404);
        expect(signIn.headers['set-cookie']).toBeUndefined();
      }
      const providers = await request(server).get('/api/auth/providers').ca(ca);
      expect(providers.status).toBe(200);
      expect(providers.body).toMatchObject({ test: false });
      const { rows } = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM session');
      expect(rows[0]!.n).toBe(0);
    });
  });
});
