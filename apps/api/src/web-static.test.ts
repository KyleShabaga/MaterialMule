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
    base = mkdtempSync(join(tmpdir(), 'materialmule-web-'));
    dist = join(base, '.hidden-parent', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Material Mule</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")');
    writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"Material Mule"}');
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

  it('serves the service worker at the root scope, always revalidated (MM-V2-C11)', async () => {
    const response = await request(app.getHttpServer()).get('/sw.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^(application|text)\/javascript/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['service-worker-allowed']).toBeUndefined();
  });

  it('serves the web app manifest with its media type (MM-V2-C11)', async () => {
    const response = await request(app.getHttpServer()).get('/manifest.webmanifest');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('answers /sw.js with 404, not index.html, when a build has no worker', async () => {
    rmSync(join(dist, 'sw.js'));
    try {
      const response = await request(app.getHttpServer()).get('/sw.js');
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('<title>Material Mule</title>');
    } finally {
      writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    }
  });

  it('returns index.html for client-side routes', async () => {
    for (const path of ['/', '/sample-storage', '/settings/staff']) {
      const response = await request(app.getHttpServer()).get(path);
      expect(response.status, path).toBe(200);
      expect(response.text).toContain('<title>Material Mule</title>');
    }
  });

  it('never shadows API routes', async () => {
    expect((await request(app.getHttpServer()).get('/api/me')).status).toBe(401);
    const missing = await request(app.getHttpServer()).get('/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain('<title>Material Mule</title>');
  });

  it('refuses a directory without index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'materialmule-empty-'));
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
