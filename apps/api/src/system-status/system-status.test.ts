import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { systemStatusResponseSchema, type BackupStatusFile } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { defaultPrinterSummary, readBackupStatusFile, summarizeBackup } from './system-status.js';

const NOW = new Date('2026-10-26T12:00:00Z');

function statusFile(overrides: Partial<BackupStatusFile> = {}): BackupStatusFile {
  const run = {
    startedAt: '2026-10-26T08:00:00Z',
    finishedAt: '2026-10-26T08:02:00Z',
    result: 'success' as const,
    message: 'Backup copied and verified',
    file: 'materialmule-production-20261026T080000Z-0.2.0.dump',
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

describe('summarizeBackup (MM-T21)', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'materialmule-status-'));
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

describe.runIf(testDatabaseUrl)('GET /api/admin/system-status (MM-T21)', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'materialmule-status-'));
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
        `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                requested_by_name_snapshot, created_at)
         VALUES ('initial', 'receiving', 'v1', $1, 'Tech', now() - make_interval(mins => $2))`,
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
      // The only printer isn't the default.
      defaultPrinter: null,
    });
    expect(body.printQueue!.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(body.printQueue!.oldestQueuedAgeSeconds).toBeLessThan(900);
    expect(body.disks.map((disk) => disk.label)).toContain('Backup location');
    // Node can measure the host drive on Windows and Linux alike.
    expect(body.disks.map((disk) => disk.label)).toContain('Material Mule host');
    // Never leaks connection details.
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
  });
});

describe.runIf(testDatabaseUrl)('defaultPrinterSummary (MTR-45)', () => {
  let db: TestSchema;
  let tech: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'TEC');
    // Fictional printers; nothing listens on these ports and the worker isn't running here.
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default, check_status) VALUES
         ('front', 'Front bench', '127.0.0.1', 9191, true, true),
         ('back', 'Back bench', '127.0.0.1', 9192, false, false)`,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM print_job');
  });

  /** A job the worker has tried, `minutesAgo` before now. */
  async function job(
    printer: string,
    status: 'queued' | 'sent' | 'failed' | 'uncertain',
    minutesAgo: number,
    details: { attempts?: number; error?: string; printerMessage?: string } = {},
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                              requested_by_name_snapshot, status, attempts, last_error,
                              printer_message, created_at, updated_at, sent_at)
       VALUES ('reprint', $1, 'v1', $2, 'Tech', $3, $4, $5, $6,
               now() - make_interval(mins => $7), now() - make_interval(mins => $7),
               CASE WHEN $3 = 'sent' THEN now() - make_interval(mins => $7) END)`,
      [
        printer,
        tech,
        status,
        details.attempts ?? 1,
        details.error ?? null,
        details.printerMessage ?? null,
        minutesAgo,
      ],
    );
  }

  it('names the default printer with no attempt before anything has been tried', async () => {
    // A queued job nobody has tried yet isn't an outcome.
    await job('front', 'queued', 1, { attempts: 0 });
    expect(await defaultPrinterSummary(db.pool)).toEqual({
      key: 'front',
      name: 'Front bench',
      enabled: true,
      checkStatus: true,
      lastAttempt: null,
      failingSince: null,
    });
  });

  it('reports a retrying job with its reason and printer message, failing since the first one after the last good print', async () => {
    await job('front', 'sent', 30);
    await job('front', 'failed', 20, { attempts: 3, error: 'Printer refused the connection' });
    await job('front', 'queued', 5, {
      attempts: 2,
      error: "Printer didn't respond",
      printerMessage: 'Printer out of labels',
    });
    // Another printer's newer success doesn't count.
    await job('back', 'sent', 1);
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({
      outcome: 'retrying',
      error: "Printer didn't respond",
      printerMessage: 'Printer out of labels',
    });
    const at = Date.parse(summary!.lastAttempt!.at);
    const since = Date.parse(summary!.failingSince!);
    expect(Date.now() - at).toBeGreaterThanOrEqual(5 * 60_000 - 5_000);
    expect(at - since).toBeGreaterThanOrEqual(15 * 60_000 - 5_000);
    expect(at - since).toBeLessThan(16 * 60_000);
  });

  it('reports failed once the retries run out', async () => {
    await job('front', 'failed', 2, { attempts: 3, error: 'Printer refused the connection' });
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({
      outcome: 'failed',
      error: 'Printer refused the connection',
    });
    expect(summary!.failingSince).not.toBeNull();
  });

  it('goes back to ok after a successful print, and ignores confirmed uncertain jobs', async () => {
    await job('front', 'failed', 20, { attempts: 3, error: 'Printer refused the connection' });
    await job('front', 'sent', 10);
    await job('front', 'uncertain', 30, { error: 'Connection dropped' });
    await db.pool.query(
      `UPDATE print_job SET physically_confirmed_at = now(), physically_confirmed_by_user_id = $1,
                            confirmed_by_name_snapshot = 'Tech', updated_at = now()
        WHERE status = 'uncertain'`,
      [tech],
    );
    const summary = await defaultPrinterSummary(db.pool);
    expect(summary!.lastAttempt).toMatchObject({ outcome: 'ok', error: null });
    expect(summary!.failingSince).toBeNull();
  });

  it('reports an unconfirmed uncertain job as uncertain', async () => {
    await job('front', 'sent', 10);
    await job('front', 'uncertain', 1, { error: 'Connection dropped' });
    expect((await defaultPrinterSummary(db.pool))!.lastAttempt).toMatchObject({
      outcome: 'uncertain',
      error: 'Connection dropped',
    });
  });

  it('is null when no printer is the default', async () => {
    await db.pool.query(`UPDATE printer SET is_default = false`);
    try {
      expect(await defaultPrinterSummary(db.pool)).toBeNull();
    } finally {
      await db.pool.query(`UPDATE printer SET is_default = true WHERE key = 'front'`);
    }
  });
});
