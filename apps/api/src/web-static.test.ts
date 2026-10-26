import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config/env.js';
import { createApp } from './create-app.js';

describe('serving the built web app (WEB_DIST_DIR)', () => {
  let app: INestApplication;
  let base: string;
  let dist: string;

  beforeAll(async () => {
    // A dot folder above the build (as in a .claude/worktrees checkout) must not hide it.
    base = mkdtempSync(join(tmpdir(), 'trapezoid-web-'));
    dist = join(base, '.hidden-parent', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Trapezoid</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")');
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: 'postgres://nobody:nopw@127.0.0.1:1/nothing',
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        WEB_DIST_DIR: dist,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('serves static files', async () => {
    const response = await request(app.getHttpServer()).get('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.text).toContain('console.log');
  });

  it('returns index.html for client-side routes', async () => {
    for (const path of ['/', '/sample-storage', '/settings/staff']) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.status, path).toBe(200);
      expect(response.text).toContain('<title>Trapezoid</title>');
    }
  });

  it('never shadows API routes', async () => {
    expect((await request(app.getHttpServer()).get('/api/me')).status).toBe(401);
    const missing = await request(app.getHttpServer()).get('/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain('<title>Trapezoid</title>');
  });

  it('refuses a directory without index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'trapezoid-empty-'));
    await expect(
      createApp(
        loadConfig({
          APP_ENV: 'test',
          DATABASE_URL: 'postgres://nobody:nopw@127.0.0.1:1/nothing',
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
          LOG_LEVEL: 'silent',
          WEB_DIST_DIR: empty,
        }),
      ),
    ).rejects.toThrowError(/no index.html/);
    rmSync(empty, { recursive: true, force: true });
  });
});
