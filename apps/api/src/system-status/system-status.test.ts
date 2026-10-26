import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { systemStatusResponseSchema, type BackupStatusFile } from '@trapezoid/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertUser } from '../test-support/fixtures.js';
import { APP_VERSION } from '../version.js';
import { readBackupStatusFile, summarizeBackup } from './system-status.js';

const NOW = new Date('2026-10-26T12:00:00Z');

function statusFile(overrides: Partial<BackupStatusFile> = {}): BackupStatusFile {
  const run = {
    startedAt: '2026-10-26T08:00:00Z',
    finishedAt: '2026-10-26T08:02:00Z',
    result: 'success' as const,
    message: 'Backup copied and verified',
    file: 'trapezoid-production-20261026T080000Z-0.2.0.dump',
    sizeBytes: 1234,
    version: '0.2.0',
  };
  return {
    schemaVersion: 1,
    lastRun: run,
    lastSuccess: run,
    rpoHours: 24,
    rtoHours: 4,
    owner: 'Fictional IT owner',
    alertRecipient: 'Fictional IT monitoring',
    target: { freeBytes: 500, totalBytes: 1000 },
    ...overrides,
  };
}

describe('summarizeBackup (TRP-T21)', () => {
  it('says backups are not set up when no status file is configured', () => {
    expect(summarizeBackup(null, NOW)).toMatchObject({ state: 'not_configured' });
  });

  it('reports a missing or unreadable record as unknown', () => {
    expect(summarizeBackup({ kind: 'missing' }, NOW)).toMatchObject({
      state: 'unknown',
      message: 'No backup has run yet.',
    });
    expect(summarizeBackup({ kind: 'unreadable' }, NOW).state).toBe('unknown');
  });

  it('AC1: shows the time and success of a recent backup', () => {
    expect(summarizeBackup({ kind: 'ok', status: statusFile() }, NOW)).toMatchObject({
      state: 'ok',
      lastRunAt: '2026-10-26T08:02:00Z',
      lastRunResult: 'success',
      lastSuccessAt: '2026-10-26T08:02:00Z',
      rpoHours: 24,
    });
  });

  it('AC3: a failed last run is shown as failed even with an earlier success', () => {
    const status = statusFile({
      lastRun: {
        ...statusFile().lastRun,
        finishedAt: '2026-10-26T11:00:00Z',
        result: 'failed',
        message: 'Backup location unavailable',
        file: null,
        sizeBytes: null,
      },
    });
    expect(summarizeBackup({ kind: 'ok', status }, NOW)).toMatchObject({
      state: 'failed',
      lastRunMessage: 'Backup location unavailable',
      lastSuccessAt: '2026-10-26T08:02:00Z',
    });
  });

  it('AC4: warns when the last success is older than the RPO, or there is none', () => {
    const old = statusFile({ rpoHours: 2 });
    expect(summarizeBackup({ kind: 'ok', status: old }, NOW).state).toBe('overdue');
    expect(
      summarizeBackup({ kind: 'ok', status: statusFile({ lastSuccess: null }) }, NOW).state,
    ).toBe('overdue');
    // Exactly at the RPO is still within it.
    const edge = new Date(Date.parse('2026-10-26T08:02:00Z') + 24 * 3_600_000);
    expect(summarizeBackup({ kind: 'ok', status: statusFile() }, edge).state).toBe('ok');
  });

  it('reads a status record written by PowerShell (UTF-8 with a byte order mark)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trapezoid-status-'));
    try {
      const path = join(dir, 'backup-status.json');
      writeFileSync(path, `\uFEFF${JSON.stringify(statusFile())}`);
      expect(await readBackupStatusFile(path)).toMatchObject({ kind: 'ok' });
      writeFileSync(path, '{ not json');
      expect(await readBackupStatusFile(path)).toEqual({ kind: 'unreadable' });
      expect(await readBackupStatusFile(join(dir, 'nope.json'))).toEqual({ kind: 'missing' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(testDatabaseUrl)('GET /api/admin/system-status (TRP-T21)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let dir: string;
  const cookies: Record<string, string> = {};
  const get = (who?: string) => {
    const call = request(app.getHttpServer()).get('/api/admin/system-status');
    return who ? call.set('Cookie', cookies[who]!) : call;
  };

  beforeAll(async () => {
    db = await createMigratedSchema();
    dir = mkdtempSync(join(tmpdir(), 'trapezoid-status-'));
    const statusPath = join(dir, 'backup-status.json');
    writeFileSync(statusPath, JSON.stringify(statusFile()));

    const admin = await insertUser(db.pool, 'ADM');
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin')`, [
      admin,
    ]);
    const tech = await insertUser(db.pool, 'TEC');
    const manager = await insertUser(db.pool, 'LM');
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`, [
      manager,
    ]);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB', 'shared_lab', 'active') RETURNING id`,
    );
    const lab = rows[0]!.id;
    // Two queued jobs, the oldest 10 minutes ago (no printer exists, so the worker leaves them).
    await db.pool.query(
      `INSERT INTO printer (key, name, host, enabled) VALUES ('receiving', 'Receiving', '127.0.0.1', false)`,
    );
    for (const minutes of [10, 1]) {
      await db.pool.query(
        `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id, created_at)
         VALUES ('initial', 'receiving', 'v1', $1, now() - make_interval(mins => $2))`,
        [tech, minutes],
      );
    }

    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        BACKUP_STATUS_FILE: statusPath,
      }),
    );
    await app.init();
    const sessions = app.get(SessionService);
    cookies.admin = `${SESSION_COOKIE}=${(await sessions.create(admin, 'test')).token}`;
    cookies.tech = `${SESSION_COOKIE}=${(await sessions.create(tech, 'test')).token}`;
    cookies.manager = `${SESSION_COOKIE}=${(await sessions.create(manager, 'test')).token}`;
    cookies.lab = `${SESSION_COOKIE}=${(await sessions.create(lab, 'shared_lab')).token}`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('T4: is admin only', async () => {
    expect((await get()).status).toBe(401);
    for (const who of ['tech', 'manager', 'lab']) {
      const response = await get(who);
      expect(response.status, who).toBe(403);
      expect(response.body).toMatchObject({ code: 'forbidden' });
    }
    expect((await get('admin')).status).toBe(200);
  });

  it('shows version, database, backup, print queue backlog and disk space', async () => {
    const response = await get('admin');
    const body = systemStatusResponseSchema.parse(response.body);
    expect(body).toMatchObject({
      version: APP_VERSION,
      database: 'up',
      backup: { state: expect.any(String), lastSuccessAt: '2026-10-26T08:02:00Z', rpoHours: 24 },
      printQueue: { queued: 2, sending: 0 },
      printWorker: { running: true },
    });
    expect(body.printQueue!.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(body.printQueue!.oldestQueuedAgeSeconds).toBeLessThan(900);
    expect(body.disks.map((disk) => disk.label)).toContain('Backup location');
    // Node can measure the host drive on Windows and Linux alike.
    expect(body.disks.map((disk) => disk.label)).toContain('Trapezoid host');
    // Never leaks connection details.
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
  });
});
