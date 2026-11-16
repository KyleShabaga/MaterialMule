import type { INestApplication } from '@nestjs/common';
import { personPhotoUrl } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SIGN_IN_BINDING_COOKIE } from '../auth/providers/microsoft/microsoft-auth.controller.js';
import { MicrosoftSignInRateLimit } from '../auth/providers/microsoft/microsoft-rate-limit.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed } from '../db/seed.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_TENANT_ID,
  startMockOidc,
  type MockOidc,
} from '../test-support/mock-oidc.js';
import { jpegLikeBytes, tinyPng } from '../test-support/tiny-image.js';

const REDIRECT_URI = 'http://localhost:5173/sign-in/microsoft/callback';
const SECRET = 'test-session-secret-0123456789abcdef';

function cookieValue(response: request.Response, name: string): string | undefined {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((value) => value.startsWith(`${name}=`))?.split(';')[0];
}

// STRATA-52: directory photos fetched through the mock tenant's Graph at sign-in and refresh,
// cached on the host and served same-origin. Fictional people and generated images only.
describe.runIf(testDatabaseUrl)('directory photos (STRATA-52)', () => {
  let db: TestSchema;
  let mock: MockOidc;
  let app: INestApplication;
  let sessions: SessionService;
  const http = () => request(app.getHttpServer());

  async function signIn(key: string) {
    mock.autoSignIn(key);
    mock.autoError(null);
    const start = await http().get('/api/auth/microsoft/start?returnTo=%2F');
    const binding = cookieValue(start, SIGN_IN_BINDING_COOKIE)!;
    const authorize = await fetch(start.headers.location!, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    const callback = await http()
      .post('/api/auth/microsoft/callback')
      .set('Cookie', binding)
      .set(CSRF_HEADER, '1')
      .send({ state: back.searchParams.get('state')!, code: back.searchParams.get('code')! });
    expect(callback.status, JSON.stringify(callback.body)).toBe(200);
    return cookieValue(callback, SESSION_COOKIE)!;
  }

  async function userIdOf(key: string): Promise<string> {
    const { rows } = await db.pool.query<{ user_id: string }>(
      `SELECT user_id FROM identity_link WHERE provider = 'microsoft' AND subject = $1`,
      [mock.users.get(key)!.oid],
    );
    return rows[0]!.user_id;
  }

  async function activate(userId: string) {
    await db.pool.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [userId]);
  }

  async function storedPhoto(userId: string) {
    const { rows } = await db.pool.query<{ content_type: string; bytes: Buffer }>(
      'SELECT content_type, bytes FROM person_photo WHERE user_id = $1',
      [userId],
    );
    return rows[0];
  }

  async function labCookie(): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM app_user WHERE account_type = 'shared_lab' LIMIT 1`,
    );
    const session = await sessions.create(rows[0]!.id, 'shared_lab');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  beforeAll(async () => {
    mock = await startMockOidc();
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: SECRET,
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
    await app.init();
    sessions = app.get(SessionService);
  });

  beforeEach(() => {
    app.get(MicrosoftSignInRateLimit).reset();
    for (const user of mock.users.values()) {
      delete user.graphStatus;
      delete user.photoStatus;
    }
    mock.users.get('nograph')!.graphStatus = 503;
    mock.users.get('riley')!.photo = { contentType: 'image/png', bytes: tinyPng() };
  });

  afterAll(async () => {
    await app?.close();
    await mock?.close();
    await db?.drop();
  });

  it('caches the photo at sign-in and serves it with a private cache, ETag and nosniff', async () => {
    const avery = await signIn('avery'); // bootstrap admin: active, no photo in the tenant
    await signIn('riley');
    const riley = await userIdOf('riley');
    expect((await storedPhoto(riley))?.bytes.equals(tinyPng())).toBe(true);
    await activate(riley);

    const response = await http().get(personPhotoUrl(riley)).set('Cookie', avery);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(response.body as Buffer).equals(tinyPng())).toBe(true);
    const etag = response.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const again = await http()
      .get(personPhotoUrl(riley))
      .set('Cookie', avery)
      .set('If-None-Match', etag);
    expect(again.status).toBe(304);
    const changed = await http()
      .get(personPhotoUrl(riley))
      .set('Cookie', avery)
      .set('If-None-Match', '"0000"');
    expect(changed.status).toBe(200);
  });

  it('LAB stations read photos too; anonymous and pending sessions are refused', async () => {
    const riley = await userIdOf('riley');
    expect(
      (
        await http()
          .get(personPhotoUrl(riley))
          .set('Cookie', await labCookie())
      ).status,
    ).toBe(200);
    expect((await http().get(personPhotoUrl(riley))).status).toBe(401);
    const pending = await signIn('morgan'); // a new person: pending until an admin approves
    const refused = await http().get(personPhotoUrl(riley)).set('Cookie', pending);
    expect(refused.status).toBe(403);
  });

  it('answers 404 no_photo for no photo, a pending person, a disabled person and bad IDs', async () => {
    const avery = await signIn('avery');
    const averyId = await userIdOf('avery');
    const none = await http().get(personPhotoUrl(averyId)).set('Cookie', avery);
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ code: 'no_photo' });

    // Casey has a photo but is still pending.
    mock.users.get('casey')!.photo = { contentType: 'image/jpeg', bytes: jpegLikeBytes() };
    await signIn('casey');
    const casey = await userIdOf('casey');
    expect(await storedPhoto(casey)).toBeDefined();
    expect((await http().get(personPhotoUrl(casey)).set('Cookie', avery)).status).toBe(404);

    // Disabling deletes the cached photo.
    await activate(casey);
    expect((await http().get(personPhotoUrl(casey)).set('Cookie', avery)).status).toBe(200);
    const disabled = await http()
      .post(`/api/staff/${casey}/disable`)
      .set('Cookie', avery)
      .set(CSRF_HEADER, '1')
      .send({ reason: 'Left the company (fictional)' });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(await storedPhoto(casey)).toBeUndefined();
    expect((await http().get(personPhotoUrl(casey)).set('Cookie', avery)).status).toBe(404);

    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000999']) {
      expect((await http().get(personPhotoUrl(id)).set('Cookie', avery)).status).toBe(404);
    }
  });

  it('a Graph failure never blocks sign-in and keeps the last cached photo', async () => {
    const riley = await userIdOf('riley');
    const before = await storedPhoto(riley);
    expect(before).toBeDefined();
    mock.users.get('riley')!.photoStatus = 503;
    await signIn('riley');
    expect((await storedPhoto(riley))?.bytes.equals(before!.bytes)).toBe(true);

    // A photo that isn't a JPEG or PNG (by its bytes) is never kept either.
    delete mock.users.get('riley')!.photoStatus;
    mock.users.get('riley')!.photo = {
      contentType: 'image/png',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    };
    await signIn('riley');
    expect((await storedPhoto(riley))?.bytes.equals(before!.bytes)).toBe(true);

    // The whole Graph being down still signs the person in.
    await signIn('nograph');
  });

  it('a later sign-in with no photo in the tenant clears the cache', async () => {
    const riley = await userIdOf('riley');
    mock.users.get('riley')!.photo = undefined;
    await signIn('riley');
    expect(await storedPhoto(riley)).toBeUndefined();
  });

  it('profile refresh fetches the photo again', async () => {
    const cookie = await signIn('drew');
    const drew = await userIdOf('drew');
    expect(await storedPhoto(drew)).toBeUndefined();
    mock.users.get('drew')!.photo = { contentType: 'image/png', bytes: tinyPng(3) };
    const refreshed = await http()
      .post('/api/me/profile/refresh')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send({});
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect((await storedPhoto(drew))?.bytes.equals(tinyPng(3))).toBe(true);
  });
});
