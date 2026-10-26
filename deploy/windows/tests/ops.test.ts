// Automated tests for the backup, restore and monitoring scripts (MM-T21). They run the real
// PowerShell scripts against temp folders and the test database (a scratch schema). Only the
// Windows event log writer is faked (tests/ops-harness.ps1): nothing here registers a scheduled
// task, service or event source, and nothing runs elevated.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../apps/api/src/db/migrator';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../../../apps/api/src/test-support/fixtures';

const SCRIPTS = resolve(import.meta.dirname, '..');
const HARNESS = join(SCRIPTS, 'tests', 'ops-harness.ps1');
const isWindows = process.platform === 'win32';
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
// CI puts the server's own client tools in PGBIN; locally the EDB default.
const PG_BIN = process.env.PGBIN ?? 'C:\\Program Files\\PostgreSQL\\17\\bin';
const VERSION = '0.0.0-t21test';

// Creating a scratch database for the restore drill needs CREATEDB (CI's postgres user has it;
// a local test user usually doesn't, so locally that one test is skipped).
async function probeCreateDatabase(): Promise<boolean> {
  if (!testDatabaseUrl || !isWindows) return false;
  const probe = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  try {
    const { rows } = await probe.query<{ ok: boolean }>(
      'SELECT rolsuper OR rolcreatedb AS ok FROM pg_roles WHERE rolname = current_user',
    );
    return rows[0]?.ok === true;
  } finally {
    await probe.end();
  }
}
const canCreateDatabase = await probeCreateDatabase();
if (!canCreateDatabase && process.env.CI === 'true' && testDatabaseUrl) {
  throw new Error(
    'CI must run the restore drill test: the test database user cannot create databases.',
  );
}

function pwsh(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type Setting = string | number | boolean | null | string[];

function writePsd1(path: string, settings: Record<string, Setting>) {
  const lines = Object.entries(settings).map(([key, value]) => {
    const rendered = Array.isArray(value)
      ? `@(${value.map(psString).join(', ')})`
      : value === null
        ? '$null'
        : typeof value === 'boolean'
          ? value
            ? '$true'
            : '$false'
          : typeof value === 'number'
            ? String(value)
            : psString(value);
    return `    ${key} = ${rendered}`;
  });
  writeFileSync(path, `@{\n${lines.join('\n')}\n}\n`);
}

/** Runs PowerShell code with the ops module loaded and returns its JSON output. */
function psJson<T>(code: string): T {
  const result = pwsh([
    '-Command',
    `$ErrorActionPreference = 'Stop'; Import-Module ${psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'))}; Import-Module ${psString(join(SCRIPTS, 'MaterialMuleOps.psm1'))}; ${code}`,
  ]);
  if (result.code !== 0) throw new Error(result.output);
  return JSON.parse(result.output) as T;
}

/** A fake MM-T20 host: host.config.psd1, a current release and a service env file. */
function makeHost(work: string) {
  const root = join(work, 'host');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'current'), { recursive: true });
  writeFileSync(join(root, 'current', 'release.json'), JSON.stringify({ version: VERSION }));
  // Fictional values: the backup's config bundle must carry the keys but never these secrets.
  writeFileSync(
    join(root, 'config', 'materialmule.env'),
    [
      'APP_ENV=production',
      'DATABASE_URL=postgres://materialmule_app:fictional-db-password@127.0.0.1:5432/materialmule',
      'SESSION_SECRET=fictional-session-secret-0123456789abcdef',
      'TLS_PFX_PASSPHRASE=fictional-passphrase',
      'MICROSOFT_CLIENT_SECRET=',
      'PORT=443',
    ].join('\n'),
  );
  const hostConfig = join(root, 'config', 'host.config.psd1');
  writePsd1(hostConfig, {
    InstallRoot: root,
    ServiceName: 'MaterialMuleT21TestNoSuchService',
    // Nothing listens here: the monitor must report the health check.
    HealthUrl: 'http://127.0.0.1:9/api/health',
  });
  return { root, hostConfig };
}

describe.runIf(isWindows)('backup configuration refuses until IT decides (D39)', () => {
  let work: string;
  let hostConfig: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'materialmule-t21-config-'));
    ({ hostConfig } = makeHost(work));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('refuses the shipped example (proposal, pending IT) for backup, monitor and install', () => {
    const example = join(SCRIPTS, 'backup.config.example.psd1');
    expect(readFileSync(example, 'utf8')).toContain('PROPOSAL, PENDING IT (D39)');
    for (const script of ['backup.ps1', 'monitor.ps1']) {
      const result = pwsh(['-File', join(SCRIPTS, script), '-ConfigPath', example]);
      expect(result.code, result.output).toBe(2);
      expect(result.output).toContain(
        'BackupTarget, RpoHours, RtoHours, KeepDaily, KeepWeekly, KeepMonthly, BackupOwner, AlertRecipient, TargetEncryptedAtRest',
      );
    }
    const install = pwsh([
      '-File',
      join(SCRIPTS, 'Install-MaterialMuleHost.ps1'),
      '-ConfigPath',
      hostConfig,
      '-BackupConfigPath',
      example,
      '-WhatIf',
    ]);
    expect(install.code).not.toBe(0);
    expect(install.output).toContain('Backup configuration is incomplete');
  });

  it('Install-MaterialMuleHost.ps1 -WhatIf previews the backup folders, event source and tasks', () => {
    const path = join(work, 'backup-install.config.psd1');
    const installHost = join(work, 'host-install.config.psd1');
    writePsd1(installHost, {
      InstallRoot: join(work, 'install-root'),
      HealthUrl: 'https://materialmule.example.internal/api/health',
      ServiceName: 'MaterialMuleT21TestNoSuchService',
      ServiceAccount: 'NT SERVICE\\MaterialMuleT21Test',
      PostgresServiceName: 'MaterialMuleT21TestNoSuchPostgres',
    });
    writePsd1(path, {
      HostConfigPath: installHost,
      BackupTarget: join(work, 'target'),
      RpoHours: 24,
      RtoHours: 4,
      KeepDaily: 14,
      KeepWeekly: 8,
      KeepMonthly: 12,
      BackupOwner: 'Fictional IT owner',
      AlertRecipient: 'Fictional IT monitoring',
      TargetEncryptedAtRest: true,
      BackupAccount: 'EXAMPLE\\svc-materialmule-bk$',
      BackupTimes: ['02:00', '14:00'],
      EventLogSource: 'MaterialMuleT21TestNoSuchSource',
    });
    const result = pwsh([
      '-File',
      join(SCRIPTS, 'Install-MaterialMuleHost.ps1'),
      '-ConfigPath',
      installHost,
      '-BackupConfigPath',
      path,
      '-WhatIf',
    ]);
    expect(result.code, result.output).toBe(0);
    const output = result.output.replace(/\s+/g, ' ');
    expect(output).toContain('register Windows event log source');
    expect(output).toMatch(
      /register scheduled task: .*backup\.ps1.*daily at 02:00, 14:00, as EXAMPLE\\svc-materialmule-bk\$/,
    );
    expect(output).toMatch(/register scheduled task: .*monitor\.ps1.*every 5 min/);
    expect(output).toContain('replace permissions (no inheritance)');
    // Nothing was created on disk.
    expect(existsSync(join(work, 'install-root'))).toBe(false);
  });

  it('refuses a location that is not encrypted at rest, and bad retention', () => {
    const base = {
      HostConfigPath: hostConfig,
      BackupTarget: join(work, 'target'),
      RpoHours: 24,
      RtoHours: 4,
      KeepDaily: 14,
      KeepWeekly: 8,
      KeepMonthly: 12,
      BackupOwner: 'Fictional IT owner',
      AlertRecipient: 'Fictional IT monitoring',
    };
    const path = join(work, 'backup.config.psd1');
    writePsd1(path, { ...base, TargetEncryptedAtRest: false });
    let result = pwsh(['-File', join(SCRIPTS, 'backup.ps1'), '-ConfigPath', path]);
    expect(result.code).toBe(2);
    expect(result.output).toContain('does not encrypt backups itself');

    writePsd1(path, {
      ...base,
      KeepDaily: 0,
      KeepWeekly: 0,
      KeepMonthly: 0,
      TargetEncryptedAtRest: true,
    });
    result = pwsh(['-File', join(SCRIPTS, 'backup.ps1'), '-ConfigPath', path]);
    expect(result.code).toBe(2);
    expect(result.output).toContain('Retention keeps nothing');
  });
});

describe.runIf(isWindows)('ops helpers (MM-T21)', () => {
  it('keeps the last 24 h plus the newest backup per day, ISO week and month', () => {
    // Every 6 hours for 120 days back from 2026-10-26 12:00 UTC.
    const kept = psJson<string[]>(`
      $now = [datetime]::new(2026, 10, 26, 12, 0, 0, [DateTimeKind]::Utc)
      $backups = foreach ($h in 0..479) {
        $t = $now.AddHours(-6 * $h)
        [pscustomobject]@{ Base = $t.ToString('yyyyMMddTHHmmss'); Time = $t }
      }
      ConvertTo-Json -Compress @(Select-MaterialMuleBackupsToKeep -Backups $backups -KeepDaily 14 -KeepWeekly 8 -KeepMonthly 12 -Now $now)
    `);
    // 4 (last 24 h, 12:00 inclusive back to 18:00 the day before) + 14 days + weeks/months that
    // reach further back; each backup is counted once.
    expect(kept).toContain('20261026T120000');
    expect(kept).toContain('20261025T180000');
    expect(kept.length).toBeGreaterThan(14);
    expect(kept.length).toBeLessThan(14 + 8 + 12 + 4);
    // The monthly picks reach the oldest month on hand (June 2026, local calendar, 120 days back).
    expect([...kept].sort()[0]! < '20260702').toBe(true);
    expect(new Set(kept).size).toBe(kept.length);
  });

  it('redacts secrets in the configuration bundle', () => {
    const work = mkdtempSync(join(tmpdir(), 'materialmule-t21-redact-'));
    try {
      const { root } = makeHost(work);
      const text = psJson<string>(
        `ConvertTo-Json (Get-RedactedEnvText -Path ${psString(join(root, 'config', 'materialmule.env'))})`,
      );
      expect(text).not.toContain('fictional-db-password');
      expect(text).not.toContain('fictional-session-secret');
      expect(text).not.toContain('fictional-passphrase');
      expect(text).toContain(
        'DATABASE_URL=postgres://materialmule_app:<redacted>@127.0.0.1:5432/materialmule',
      );
      expect(text).toContain('SESSION_SECRET=<redacted: see the password manager>');
      expect(text).toContain('MICROSOFT_CLIENT_SECRET=\r\n');
      expect(text).toContain('PORT=443');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('AC5: rotates logs by size and keeps a bounded number', () => {
    const work = mkdtempSync(join(tmpdir(), 'materialmule-t21-rotate-'));
    try {
      const log = join(work, 'backup.log');
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(log, 'x'.repeat(2048));
        psJson(
          `Invoke-MaterialMuleLogRotation -Path ${psString(log)} -MaxSizeMB 0.001 -KeepFiles 3; '1'`,
        );
      }
      expect(readdirSync(work).sort()).toEqual(['backup.1.log', 'backup.2.log', 'backup.3.log']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('Deploy-MaterialMule.ps1 runs backup.ps1 with BackupConfig and stops when it fails', () => {
    const work = mkdtempSync(join(tmpdir(), 'materialmule-t21-predeploy-'));
    try {
      const { root, hostConfig } = makeHost(work);
      mkdirSync(join(root, 'logs'));
      const fake = join(work, 'fake-backup.ps1');
      writeFileSync(
        fake,
        [
          'param($ConfigPath, $Reason)',
          `Set-Content -LiteralPath ${psString(join(work, 'args.txt'))} -Value "$ConfigPath|$Reason"`,
          'exit [int]$env:T21_FAKE_BACKUP_EXIT',
        ].join('\n'),
      );
      const withBackup = join(work, 'host-backup.config.psd1');
      writeFileSync(
        withBackup,
        readFileSync(hostConfig, 'utf8').replace(
          /\}\s*$/,
          `    BackupScript = ${psString(fake)}\n    BackupConfig = 'C:\\x\\backup.config.psd1'\n}\n`,
        ),
      );
      const attempt = (exitCode: number) =>
        pwsh(
          [
            '-Command',
            `$ErrorActionPreference = 'Stop'; Import-Module ${psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'))}
             $c = Get-MaterialMuleHostConfig -Path ${psString(withBackup)}
             try { Invoke-MaterialMuleBackup -Config $c; 'backup ok' } catch { "backup refused: $($_.Exception.Message)" }`,
          ],
          { T21_FAKE_BACKUP_EXIT: String(exitCode) },
        ).output;
      expect(attempt(0)).toContain('backup ok');
      expect(readFileSync(join(work, 'args.txt'), 'utf8').trim()).toBe(
        'C:\\x\\backup.config.psd1|PreDeploy',
      );
      expect(attempt(1)).toContain('backup refused: The backup script failed');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses restore targets that could be production', () => {
    const work = mkdtempSync(join(tmpdir(), 'materialmule-t21-target-'));
    try {
      const { hostConfig } = makeHost(work);
      const config = join(work, 'backup.config.psd1');
      writePsd1(config, { HostConfigPath: hostConfig, DbName: 'materialmule' });
      const check = (target: string) =>
        psJson<string>(`
          $c = Get-MaterialMuleBackupConfig -Path ${psString(config)} -Purpose Restore
          try { Assert-MaterialMuleRestoreTarget -Config $c -TargetDatabase ${psString(target)}; ConvertTo-Json 'ok' }
          catch { ConvertTo-Json $_.Exception.Message }
        `);
      expect(check('materialmule')).toContain('it is the production database');
      expect(check('MATERIALMULE')).toContain('lowercase');
      expect(check('postgres')).toContain('system database');
      expect(check('materialmule_copy')).toContain("must contain 'restore'");
      expect(check('materialmule; drop')).toContain('lowercase');
      expect(check('materialmule_restore_20261026')).toBe('ok');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// --- Against the test database ------------------------------------------------------------------

interface Status {
  lastRun: { result: string; message: string; file: string | null; version: string };
  lastSuccess: { file: string } | null;
  rpoHours: number;
  alertRecipient: string;
  history: unknown[];
}

describe.runIf(isWindows && testDatabaseUrl)(
  'backup.ps1, restore.ps1, monitor.ps1 (MM-T21)',
  () => {
    const schema = `t21_${randomBytes(6).toString('hex')}`;
    let admin: Pool;
    let pool: Pool;
    let work: string;
    let root: string;
    let target: string;
    let configPath: string;
    let unreachableConfigPath: string;
    let env: Record<string, string>;
    const url = new URL(testDatabaseUrl ?? 'postgres://x@localhost/x');
    const settings = () => ({
      HostConfigPath: join(root, 'config', 'host.config.psd1'),
      EnvironmentName: 'test',
      BackupTarget: target,
      RpoHours: 24,
      RtoHours: 4,
      KeepDaily: 2,
      KeepWeekly: 1,
      KeepMonthly: 1,
      BackupOwner: 'Fictional IT owner',
      AlertRecipient: 'Fictional IT monitoring',
      TargetEncryptedAtRest: true,
      PgBinDir: PG_BIN,
      DbHost: url.hostname,
      DbPort: Number(url.port || 5432),
      DbName: url.pathname.slice(1),
      DbUser: decodeURIComponent(url.username),
      RestoreAdminUser: decodeURIComponent(url.username),
    });
    const events = () =>
      existsSync(env.T21_FAKE_EVENTLOG!)
        ? readFileSync(env.T21_FAKE_EVENTLOG!, 'utf8').trim().split(/\r?\n/).filter(Boolean)
        : [];
    const status = () =>
      JSON.parse(
        readFileSync(join(root, 'ops', 'status', 'backup-status.json'), 'utf8').replace(
          /^\uFEFF/,
          '',
        ),
      ) as Status;
    const run = (script: string, ...args: string[]) =>
      pwsh(['-File', HARNESS, '-Script', script, ...args], env);

    beforeAll(async () => {
      admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: testDatabaseUrl,
        max: 2,
        options: `-c search_path=${schema}`,
      });
      await migrate(pool);

      // Fictional receiving history: units in two prefixes and years, summaries, audit, a print job.
      const user = await insertUser(pool, 'AT');
      const location = await receivingLabId(pool);
      const project = await insertProject(pool, 'DEMO-2601', user);
      const hole = await insertTestHole(pool, project, 'TH26-01');
      const receipt = await insertReceipt(pool, project, user, 7);
      const readableIds = [
        'BKT-2025-000009',
        'BKT-2026-000001',
        'BKT-2026-000002',
        'BKT-2026-000003',
        'ST-2026-000001',
        'ST-2026-000002',
        'BKT-2026-000004',
      ];
      const unitIds: string[] = [];
      for (const readableId of readableIds) {
        const prefix = readableId.split('-')[0]!;
        const kind = prefix === 'ST' ? 'shelby_tube' : 'bucket';
        const id = await insertStorageUnit(
          pool,
          { projectId: project, receiptId: receipt, locationId: location },
          { readableId, issuedHolderKind: kind, unitType: kind },
        );
        unitIds.push(id);
        await insertSummary(
          pool,
          { storageUnitId: id, projectId: project, testHoleId: hole },
          { type: 'all' },
        );
      }
      await pool.query(
        `INSERT INTO storage_unit_annual_counter (prefix, year, last_value)
       VALUES ('BKT', 2025, 9), ('BKT', 2026, 4), ('ST', 2026, 2)`,
      );
      for (const action of ['receipt.confirm', 'storage_unit.correct', 'label.print_sent']) {
        await pool.query(
          `INSERT INTO audit_event (action, entity_type, entity_id, actor_user_id, actor_account_type)
         VALUES ($1, 'receipt', $2, $3, 'test')`,
          [action, receipt, user],
        );
      }
      await pool.query(
        `INSERT INTO printer (key, name, host, enabled) VALUES ('receiving', 'Receiving', '127.0.0.1', false)`,
      );
      await pool.query(
        `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id, created_at)
       VALUES ('initial', 'receiving', 'v1', $1, now() - interval '30 minutes')`,
        [user],
      );

      work = mkdtempSync(join(tmpdir(), 'materialmule-t21-'));
      ({ root } = makeHost(work));
      target = join(work, 'target');
      mkdirSync(target);
      configPath = join(work, 'backup.config.psd1');
      writePsd1(configPath, settings());
      unreachableConfigPath = join(work, 'backup-unreachable.config.psd1');
      writePsd1(unreachableConfigPath, {
        ...settings(),
        BackupTarget: join(work, 'unplugged-usb'),
      });
      env = {
        T21_FAKE_EVENTLOG: join(work, 'events.log'),
        PGPASSWORD: decodeURIComponent(url.password),
        // libpq reads it: the scripts' psql sees the scratch schema; pg_dump dumps everything.
        PGOPTIONS: `-c search_path=${schema}`,
      };
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('-WhatIf lists the plan and writes nothing', () => {
      const result = run('backup.ps1', '-ConfigPath', configPath, '-WhatIf');
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('What if: pg_dump --format=custom');
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(root, 'ops'))).toBe(false);
      expect(events()).toEqual([]);
    });

    it('T1/AC1: writes the dump, manifest, config bundle and checksum to the location and records success', () => {
      // Old backups of this environment (one per day) and files retention must never touch.
      const old = ['20260901T020000Z', '20261001T020000Z', '20261020T020000Z', '20261021T020000Z'];
      for (const stamp of old) {
        writeFileSync(join(target, `materialmule-test-${stamp}-0.0.1.dump`), 'old');
        writeFileSync(join(target, `materialmule-test-${stamp}-0.0.1.sha256`), 'old');
      }
      writeFileSync(
        join(target, 'materialmule-production-20260901T020000Z-0.0.1.dump'),
        'other env',
      );
      writeFileSync(
        join(target, 'materialmule-production-20260901T020000Z-0.0.1.sha256'),
        'other env',
      );
      writeFileSync(join(target, 'notes.txt'), 'IT notes');

      const result = run('backup.ps1', '-ConfigPath', configPath);
      expect(result.code, result.output).toBe(0);
      const files = readdirSync(target);
      const dump = files.find((f) =>
        /^materialmule-test-\d{8}T\d{6}Z-0\.0\.0-t21test\.dump$/.test(f),
      );
      expect(dump, files.join(', ')).toBeDefined();
      const base = dump!.replace(/\.dump$/, '');
      for (const suffix of ['.sha256', '.manifest.json', '.config.zip']) {
        expect(files).toContain(`${base}${suffix}`);
      }
      expect(files.some((f) => f.endsWith('.partial'))).toBe(false);

      // Checksums verify; the manifest has the card's verification values.
      const verify = psJson<{ Valid: boolean }>(
        `Test-MaterialMuleBackupChecksum -DumpPath ${psString(join(target, dump!))} | ConvertTo-Json`,
      );
      expect(verify.Valid).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(target, `${base}.manifest.json`), 'utf8').replace(/^\uFEFF/, ''),
      ) as { checks: string[]; stable: boolean; version: string };
      expect(manifest.version).toBe(VERSION);
      expect(manifest.stable).toBe(true);
      expect(manifest.checks).toEqual(
        expect.arrayContaining([
          'count.receipt|1',
          'count.storage_unit|7',
          'count.storage_unit_hole_summary|7',
          'count.audit_event|3',
          'count.print_job|1',
          'latest_id.BKT-2025|BKT-2025-000009',
          'latest_id.BKT-2026|BKT-2026-000004',
          'latest_id.ST-2026|ST-2026-000002',
          'counter.BKT-2026|4',
        ]),
      );
      expect(manifest.checks.filter((line) => line.startsWith('unit.'))).toHaveLength(5);
      expect(manifest.checks.some((line) => line.startsWith('audit.fingerprint|'))).toBe(true);

      // Configuration bundle: no secret values.
      const listing = psJson<string>(`
      $dir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
      Expand-Archive -LiteralPath ${psString(join(target, `${base}.config.zip`))} -DestinationPath $dir
      $text = (Get-ChildItem $dir | ForEach-Object { $_.Name + ':' + (Get-Content -Raw $_.FullName) }) -join ' '
      Remove-Item -Recurse -Force $dir
      ConvertTo-Json $text
    `);
      expect(listing).toContain('materialmule.env.redacted');
      expect(listing).toContain('host.config.psd1');
      expect(listing).toContain('release.json');
      expect(listing).not.toContain('fictional-db-password');
      expect(listing).not.toContain('fictional-session-secret');

      // Retention (2 daily, 1 weekly, 1 monthly): 2026-10-21 and 2026-10-20 go, as do the older
      // months beyond KeepMonthly; other environments and other files stay.
      const remaining = readdirSync(target);
      expect(remaining).not.toContain('materialmule-test-20260901T020000Z-0.0.1.dump');
      expect(remaining).not.toContain('materialmule-test-20261001T020000Z-0.0.1.dump');
      expect(remaining).not.toContain('materialmule-test-20261020T020000Z-0.0.1.dump');
      expect(remaining).toContain('materialmule-test-20261021T020000Z-0.0.1.dump');
      expect(remaining).toContain('materialmule-production-20260901T020000Z-0.0.1.dump');
      expect(remaining).toContain('notes.txt');

      // Status record (Settings → System status) and an informational event.
      expect(status()).toMatchObject({
        lastRun: { result: 'success', file: dump, version: VERSION },
        lastSuccess: { file: dump },
        rpoHours: 24,
        alertRecipient: 'Fictional IT monitoring',
      });
      expect(events().some((e) => e.startsWith('MaterialMule|Information|1000|'))).toBe(true);
      // The local staging copy is gone once the location holds a verified copy.
      expect(readdirSync(join(root, 'ops', 'staging'))).toEqual([]);
      expect(readFileSync(join(root, 'ops', 'logs', 'backup.log'), 'utf8')).not.toContain(
        env.PGPASSWORD!,
      );
    });

    it('T3/AC3: an unavailable location is recorded as failed and alerted; the last success stays', () => {
      const before = status();
      const result = run('backup.ps1', '-ConfigPath', unreachableConfigPath);
      expect(result.code, result.output).toBe(1);
      const after = status();
      expect(after.lastRun).toMatchObject({ result: 'failed', file: null });
      expect(after.lastRun.message).toContain('Backup location unavailable');
      expect(after.lastSuccess).toEqual(before.lastSuccess);
      const alert = events().find((e) => e.startsWith('MaterialMule|Error|1001|'));
      expect(alert).toContain('Backup location unavailable');
      expect(alert).toContain('Alert recipient: Fictional IT monitoring');
      // This run's dump stays in staging so it can be copied by hand.
      expect(readdirSync(join(root, 'ops', 'staging')).some((f) => f.endsWith('.dump'))).toBe(true);
    });

    it('monitor: reports the failed backup, the stopped service and the waiting print job, alerting once', () => {
      let result = run('monitor.ps1', '-ConfigPath', configPath);
      expect(result.code, result.output).toBe(1);
      const monitor = JSON.parse(
        readFileSync(join(root, 'ops', 'status', 'monitor-status.json'), 'utf8').replace(
          /^\uFEFF/,
          '',
        ),
      ) as { problems: string[] };
      expect(monitor.problems.join('\n')).toContain('Backup: last run failed');
      expect(monitor.problems.join('\n')).toContain(
        'Service MaterialMuleT21TestNoSuchService is not installed',
      );
      expect(monitor.problems.join('\n')).toContain('Health check: no response');
      expect(monitor.problems.join('\n')).toMatch(/Print queue: a label job has waited \d+ min/);
      const alerts = () => events().filter((e) => e.startsWith('MaterialMule|Warning|1100|'));
      expect(alerts()).toHaveLength(1);
      // Same problems again: no repeat alert.
      result = run('monitor.ps1', '-ConfigPath', configPath);
      expect(result.code).toBe(1);
      expect(alerts()).toHaveLength(1);
    });

    it('AC4: the monitor warns when the last success is older than the RPO', () => {
      const stale = join(work, 'backup-stale.config.psd1');
      writePsd1(stale, { ...settings(), RpoHours: 0.0001 });
      const result = run('monitor.ps1', '-ConfigPath', stale);
      expect(result.code).toBe(1);
      expect(result.output).toContain('no successful backup within the RPO');
    });

    it('restore.ps1 refuses production and backups that fail their checksum', () => {
      const dump = readdirSync(target).find((f) => f.includes(VERSION) && f.endsWith('.dump'))!;
      let result = run(
        'restore.ps1',
        '-ConfigPath',
        configPath,
        '-BackupFile',
        join(target, dump),
        '-TargetDatabase',
        url.pathname.slice(1),
      );
      expect(result.code).toBe(2);
      expect(result.output).toContain('it is the production database');

      // A tampered copy fails its checksum before anything connects.
      const tampered = join(work, 'tampered');
      mkdirSync(tampered);
      const base = dump.replace(/\.dump$/, '');
      for (const suffix of ['.dump', '.sha256', '.manifest.json', '.config.zip']) {
        writeFileSync(
          join(tampered, `${base}${suffix}`),
          readFileSync(join(target, `${base}${suffix}`)),
        );
      }
      writeFileSync(join(tampered, dump), 'not the real dump');
      result = run(
        'restore.ps1',
        '-ConfigPath',
        configPath,
        '-BackupFile',
        join(tampered, dump),
        '-TargetDatabase',
        'materialmule_test_t21_restore_never',
      );
      expect(result.code).toBe(2);
      expect(result.output).toContain('does not match its SHA-256');
    });

    it.runIf(canCreateDatabase)(
      'T2/AC2/AC6: restores into a new isolated database, matches the manifest and records the drill',
      async () => {
        const dump = readdirSync(target).find((f) => f.includes(VERSION) && f.endsWith('.dump'))!;
        const scratch = `materialmule_test_t21_restore_${randomBytes(4).toString('hex')}`;
        try {
          const result = run(
            'restore.ps1',
            '-ConfigPath',
            configPath,
            '-BackupFile',
            join(target, dump),
            '-TargetDatabase',
            scratch,
            '-DropAfterVerify',
          );
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain('Result: verified');
          const drills = readFileSync(join(root, 'ops', 'logs', 'restore-drills.jsonl'), 'utf8')
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line.replace(/^\uFEFF/, '')) as Record<string, unknown>);
          expect(drills.at(-1)).toMatchObject({
            backup: dump,
            targetDatabase: scratch,
            result: 'verified',
            differences: [],
            dropped: true,
          });
          expect(typeof drills.at(-1)!.durationSeconds).toBe('number');
          expect(events().some((e) => e.startsWith('MaterialMule|Information|1200|'))).toBe(true);

          // Restoring again into an existing database is refused (kept for this check only).
          await admin.query(`CREATE DATABASE ${scratch}`);
          const again = run(
            'restore.ps1',
            '-ConfigPath',
            configPath,
            '-BackupFile',
            join(target, dump),
            '-TargetDatabase',
            scratch,
          );
          expect(again.code).toBe(2);
          expect(again.output).toContain('already exists');
        } finally {
          await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
        }
      },
    );
  },
);
