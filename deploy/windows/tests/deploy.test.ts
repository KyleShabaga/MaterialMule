// Automated tests for the Windows deploy scripts (MM-T20). They run the real PowerShell scripts
// against temp folders. Only Windows service control is faked (tests/harness.ps1): nothing here
// registers a service, opens a firewall port or changes system settings.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = resolve(import.meta.dirname, '..');
const HARNESS = join(SCRIPTS, 'tests', 'harness.ps1');
const isWindows = process.platform === 'win32';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
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

/** A host configuration file (.psd1) for a temp install root. */
function writeConfig(path: string, settings: Record<string, string | number | string[]>) {
  const lines = Object.entries(settings).map(([key, value]) => {
    const rendered = Array.isArray(value)
      ? `@(${value.map(psString).join(', ')})`
      : typeof value === 'number'
        ? String(value)
        : psString(value);
    return `    ${key} = ${rendered}`;
  });
  writeFileSync(path, `@{\n${lines.join('\n')}\n}\n`);
}

// A fake release: main.js answers /api/health (healthy or not), db/cli.js records which database
// URL migrations would use and can fail on purpose. CommonJS, so no package.json is needed.
const FAKE_MAIN = `
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const release = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'release.json'), 'utf8'));
http.createServer((req, res) => {
  if (req.url !== '/api/health') { res.writeHead(404); res.end(); return; }
  const ok = release.fakeHealthy;
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', version: release.version, database: ok ? 'up' : 'down' }));
}).listen(Number(process.env.T20_FAKE_PORT), '127.0.0.1');
`;
const FAKE_CLI = `
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const release = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'release.json'), 'utf8'));
// Like the real CLI: load ENV_FILE (the service env), which must not override the migration URL.
process.loadEnvFile(process.env.ENV_FILE);
appendFileSync(process.env.T20_FAKE_LOG, 'migrate ' + release.version + ' ' + process.env.DATABASE_URL + '\\n');
process.exit(release.fakeMigrationFails ? 1 : 0);
`;

function makeRelease(
  parent: string,
  version: string,
  options: { healthy?: boolean; migrationFails?: boolean } = {},
): string {
  const dir = join(parent, `materialmule-${version}`);
  mkdirSync(join(dir, 'apps', 'api', 'dist', 'db'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'web', 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'release.json'),
    JSON.stringify({
      version,
      fakeHealthy: options.healthy ?? true,
      fakeMigrationFails: options.migrationFails ?? false,
    }),
  );
  writeFileSync(join(dir, 'apps', 'api', 'dist', 'main.js'), FAKE_MAIN);
  writeFileSync(join(dir, 'apps', 'api', 'dist', 'db', 'cli.js'), FAKE_CLI);
  writeFileSync(join(dir, 'apps', 'web', 'dist', 'index.html'), '<!doctype html><title>x</title>');
  return dir;
}

describe.runIf(isWindows)('Deploy-MaterialMule.ps1 (MM-T20)', () => {
  let work: string;
  let root: string;
  let port: number;
  let env: Record<string, string>;
  let config: string;
  let configNoBackup: string;
  let sources: string;

  const log = () =>
    existsSync(env.T20_FAKE_LOG!)
      ? readFileSync(env.T20_FAKE_LOG!, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];
  const clearLog = () => rmSync(env.T20_FAKE_LOG!, { force: true });
  /** The version the `current` junction points at. */
  const current = (): string | null =>
    existsSync(join(root, 'current'))
      ? JSON.parse(readFileSync(join(root, 'current', 'release.json'), 'utf8')).version
      : null;
  const state = () => JSON.parse(readFileSync(join(root, 'deploy-state.json'), 'utf8'));
  async function health(): Promise<{ http: number; version?: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await response.json()) as { version?: string };
    return { http: response.status, version: body.version };
  }
  const deploy = (...args: string[]) => pwsh(['-File', HARNESS, ...args], env);

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'materialmule-deploy-'));
    root = join(work, 'host');
    sources = join(work, 'incoming');
    mkdirSync(join(root, 'config', 'admin'), { recursive: true });
    mkdirSync(join(root, 'releases'), { recursive: true });
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(sources, { recursive: true });
    port = await freePort();
    env = {
      T20_FAKE_LOG: join(work, 'events.log'),
      T20_FAKE_PID: join(work, 'fake.pid'),
      T20_FAKE_PORT: String(port),
    };
    // Fictional connection strings: which one reaches the migration step is what matters.
    writeFileSync(
      join(root, 'config', 'materialmule.env'),
      'APP_ENV=production\nDATABASE_URL=postgres://fake_app@127.0.0.1:5432/fake\n',
    );
    writeFileSync(
      join(root, 'config', 'admin', 'migrate.env'),
      'DATABASE_URL=postgres://fake_owner@127.0.0.1:5432/fake\n',
    );
    const backup = join(work, 'backup.ps1');
    writeFileSync(backup, `Add-Content -LiteralPath $env:T20_FAKE_LOG -Value 'backup'\n`);
    const common = {
      InstallRoot: root,
      ServiceName: 'MaterialMuleT20TestNoSuchService',
      NodeExe: process.execPath,
      HealthUrl: `http://127.0.0.1:${port}/api/health`,
      HealthTimeoutSeconds: 8,
      KeepReleases: 3,
    };
    config = join(work, 'host.config.psd1');
    writeConfig(config, { ...common, BackupScript: backup });
    configNoBackup = join(work, 'host.nobackup.psd1');
    writeConfig(configNoBackup, common);
  });

  afterAll(() => {
    if (env && existsSync(env.T20_FAKE_PID!)) {
      try {
        process.kill(Number(readFileSync(env.T20_FAKE_PID!, 'utf8').trim()));
      } catch {
        // Already gone.
      }
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('previews with -WhatIf and changes nothing', () => {
    const release = makeRelease(sources, '1.0.0-aaaaaa1');
    const result = deploy('-ConfigPath', config, '-Release', release, '-WhatIf');
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('What if: stop service');
    expect(result.output).toContain('on failure: roll back to (nothing: first install)');
    expect(readdirSync(join(root, 'releases'))).toEqual([]);
    expect(existsSync(join(root, 'current'))).toBe(false);
    expect(log()).toEqual([]);
  });

  it('refuses to deploy without a backup step, before changing anything', () => {
    const release = join(sources, 'materialmule-1.0.0-aaaaaa1');
    const result = deploy('-ConfigPath', configNoBackup, '-Release', release);
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain('No BackupScript is configured');
    expect(readdirSync(join(root, 'releases'))).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('installs the first release: migrate as the migration role, start, health check', async () => {
    const release = join(sources, 'materialmule-1.0.0-aaaaaa1');
    const result = deploy('-ConfigPath', config, '-Release', release);
    expect(result.code, result.output).toBe(0);
    expect(log()).toEqual([
      'backup',
      'migrate 1.0.0-aaaaaa1 postgres://fake_owner@127.0.0.1:5432/fake',
      'start',
    ]);
    expect(current()).toBe('1.0.0-aaaaaa1');
    expect(await health()).toMatchObject({ http: 200, version: '1.0.0-aaaaaa1' });
    expect(readFileSync(join(root, 'logs', 'deploy.log'), 'utf8')).toContain(
      'Deployed 1.0.0-aaaaaa1; health check passed',
    );
  });

  it('upgrades in order: backup, stop, switch, migrate, start, health', async () => {
    clearLog();
    const release = makeRelease(sources, '1.0.1-bbbbbb2');
    const result = deploy('-ConfigPath', config, '-Release', release);
    expect(result.code, result.output).toBe(0);
    expect(log()).toEqual([
      'backup',
      'stop',
      'migrate 1.0.1-bbbbbb2 postgres://fake_owner@127.0.0.1:5432/fake',
      'start',
    ]);
    expect(current()).toBe('1.0.1-bbbbbb2');
    expect(state()).toMatchObject({ Current: '1.0.1-bbbbbb2', Previous: '1.0.0-aaaaaa1' });
    expect(await health()).toMatchObject({ http: 200, version: '1.0.1-bbbbbb2' });
  });

  it('rolls back automatically when the new release fails its health check (AC3)', async () => {
    clearLog();
    const release = makeRelease(sources, '1.0.2-cccccc3', { healthy: false });
    const result = deploy('-ConfigPath', config, '-Release', release);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Outcome: RolledBack');
    expect(log()).toEqual([
      'backup',
      'stop',
      'migrate 1.0.2-cccccc3 postgres://fake_owner@127.0.0.1:5432/fake',
      'start',
      'stop',
      'start',
    ]);
    expect(current()).toBe('1.0.1-bbbbbb2');
    expect(await health()).toMatchObject({ http: 200, version: '1.0.1-bbbbbb2' });
  });

  it('rolls back without starting the new release when its migrations fail', async () => {
    clearLog();
    const release = makeRelease(sources, '1.0.3-dddddd4', { migrationFails: true });
    const result = deploy('-ConfigPath', config, '-Release', release);
    expect(result.code, result.output).toBe(1);
    expect(log()).toEqual([
      'backup',
      'stop',
      'migrate 1.0.3-dddddd4 postgres://fake_owner@127.0.0.1:5432/fake',
      'stop',
      'start',
    ]);
    expect(current()).toBe('1.0.1-bbbbbb2');
    expect(await health()).toMatchObject({ http: 200, version: '1.0.1-bbbbbb2' });
  });

  it('refuses to deploy a version that is already on the host', () => {
    const result = deploy(
      '-ConfigPath',
      config,
      '-Release',
      join(sources, 'materialmule-1.0.0-aaaaaa1'),
    );
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain('already on this host');
  });

  it('rolls back by hand to a named release', async () => {
    clearLog();
    const result = deploy('-ConfigPath', config, '-Rollback', '-ToVersion', '1.0.0-aaaaaa1');
    expect(result.code, result.output).toBe(0);
    expect(log()).toEqual(['stop', 'start']);
    expect(current()).toBe('1.0.0-aaaaaa1');
    expect(await health()).toMatchObject({ http: 200, version: '1.0.0-aaaaaa1' });
  });

  it('keeps the newest releases plus the one to roll back to', () => {
    const release = makeRelease(sources, '1.0.4-eeeeee5');
    const result = deploy('-ConfigPath', config, '-Release', release);
    expect(result.code, result.output).toBe(0);
    const kept = readdirSync(join(root, 'releases'));
    expect(kept).toContain('1.0.4-eeeeee5');
    expect(kept).toContain('1.0.0-aaaaaa1');
    expect(kept).not.toContain('1.0.1-bbbbbb2');
    expect(kept.length).toBeLessThanOrEqual(4);
  });
});

// MM-T41 regression tests: a failed backup must stop the deploy before anything changes, whether
// the backup is a PowerShell wrapper whose last native command fails (the reviewed bug: `$?` alone
// stayed true), a script that throws or exits non-zero, or a native command configured directly.
// A successful backup must not be failed by a stale non-zero $LASTEXITCODE from earlier.
describe.runIf(isWindows)('pre-deploy backup failures (MM-T41)', () => {
  let work: string;
  let root: string;
  let port: number;
  let env: Record<string, string>;
  let sources: string;
  let common: Record<string, string | number>;
  const configs: Record<string, string> = {};

  const BASELINE = '2.0.0-aaaaaa1';
  const NEXT = '2.0.1-bbbbbb2';

  // Each backup appends 'backup' to the event log first, so the tests see that it really ran.
  const MARK = `Add-Content -LiteralPath $env:T20_FAKE_LOG -Value 'backup'`;
  const BACKUPS: Record<string, { file: string; body: string }> = {
    ok: { file: 'ok.ps1', body: `${MARK}\n` },
    okNative: { file: 'ok-native.ps1', body: `${MARK}\n& cmd.exe /d /c exit 0\n` },
    nativeFails: { file: 'native-fails.ps1', body: `${MARK}\n& cmd.exe /d /c exit 42\n` },
    nativeFailsWithConfig: {
      file: 'native-fails-config.ps1',
      body: `param([string]$ConfigPath, [string]$Reason)\n${MARK}\n& cmd.exe /d /c exit 42\n`,
    },
    throws: { file: 'throws.ps1', body: `${MARK}\nthrow 'Backup target unreachable'\n` },
    exits: { file: 'exits.ps1', body: `${MARK}\nexit 5\n` },
    writesError: {
      file: 'writes-error.ps1',
      body: `${MARK}\nWrite-Error 'pg_dump reported an error'\n`,
    },
    directNative: {
      file: 'native-backup.cmd',
      body: '@echo off\r\necho backup>>"%T20_FAKE_LOG%"\r\nexit /b 42\r\n',
    },
  };

  const log = () =>
    existsSync(env.T20_FAKE_LOG!)
      ? readFileSync(env.T20_FAKE_LOG!, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      : [];
  const clearLog = () => rmSync(env.T20_FAKE_LOG!, { force: true });
  const current = (): string | null =>
    existsSync(join(root, 'current'))
      ? JSON.parse(readFileSync(join(root, 'current', 'release.json'), 'utf8')).version
      : null;
  const stateText = () => readFileSync(join(root, 'deploy-state.json'), 'utf8');
  /** One fresh connection per check: a pooled keep-alive socket may belong to a stopped server. */
  function health(): Promise<{ http: number; version?: string }> {
    return new Promise((done, fail) => {
      httpGet(`http://127.0.0.1:${port}/api/health`, { agent: false }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          const body = JSON.parse(text) as { version?: string };
          done({ http: response.statusCode ?? 0, version: body.version });
        });
      }).on('error', fail);
    });
  }
  const deploy = (...args: string[]) => pwsh(['-File', HARNESS, ...args], env);

  /**
   * Calls Invoke-MaterialMuleBackup directly, after leaving $LASTEXITCODE at 9 from an unrelated
   * native command, and reports whether it passed.
   */
  function backupHelper(config: string) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module ${psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'))}`,
      `$config = Get-MaterialMuleHostConfig -Path ${psString(config)}`,
      '& cmd.exe /d /c exit 9',
      'try { Invoke-MaterialMuleBackup -Config $config; "RESULT=passed" }',
      'catch { "RESULT=failed: $($_.Exception.Message)" }',
    ].join('\n');
    return pwsh(['-Command', script], env);
  }

  /** Everything a refused deploy must leave alone. */
  async function unchanged() {
    return {
      log: log(),
      current: current(),
      releases: readdirSync(join(root, 'releases')),
      state: stateText(),
      health: await health(),
    };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'materialmule-backup-'));
    root = join(work, 'host');
    sources = join(work, 'incoming');
    mkdirSync(join(root, 'config', 'admin'), { recursive: true });
    mkdirSync(join(root, 'releases'), { recursive: true });
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(sources, { recursive: true });
    port = await freePort();
    env = {
      T20_FAKE_LOG: join(work, 'events.log'),
      T20_FAKE_PID: join(work, 'fake.pid'),
      T20_FAKE_PORT: String(port),
    };
    writeFileSync(
      join(root, 'config', 'materialmule.env'),
      'APP_ENV=production\nDATABASE_URL=postgres://fake_app@127.0.0.1:5432/fake\n',
    );
    writeFileSync(
      join(root, 'config', 'admin', 'migrate.env'),
      'DATABASE_URL=postgres://fake_owner@127.0.0.1:5432/fake\n',
    );
    // A fictional backup.config.psd1: only its path is passed on to the wrapper.
    const backupConfig = join(work, 'backup.config.psd1');
    writeFileSync(backupConfig, '@{}\n');
    common = {
      InstallRoot: root,
      ServiceName: 'MaterialMuleT41TestNoSuchService',
      NodeExe: process.execPath,
      HealthUrl: `http://127.0.0.1:${port}/api/health`,
      HealthTimeoutSeconds: 8,
      KeepReleases: 3,
    };
    for (const [key, backup] of Object.entries(BACKUPS)) {
      const script = join(work, backup.file);
      writeFileSync(script, backup.body);
      configs[key] = join(work, `host.${key}.psd1`);
      writeConfig(configs[key], {
        ...common,
        BackupScript: script,
        ...(key === 'nativeFailsWithConfig' ? { BackupConfig: backupConfig } : {}),
      });
    }
    configs.none = join(work, 'host.nobackup.psd1');
    writeConfig(configs.none, common);

    // A running baseline release, so a refused deploy has a release, service and state to keep.
    const result = deploy('-ConfigPath', configs.ok!, '-Release', makeRelease(sources, BASELINE));
    expect(result.code, result.output).toBe(0);
    makeRelease(sources, NEXT);
  });

  afterAll(() => {
    if (env && existsSync(env.T20_FAKE_PID!)) {
      try {
        process.kill(Number(readFileSync(env.T20_FAKE_PID!, 'utf8').trim()));
      } catch {
        // Already gone.
      }
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('AC1/AC2: a wrapper whose native command exits 42 stops the deploy with exit code 3', async () => {
    const before = await unchanged();
    clearLog();
    const result = deploy(
      '-ConfigPath',
      configs.nativeFails!,
      '-Release',
      join(sources, `materialmule-${NEXT}`),
    );
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain('Stopped: The backup script failed; nothing was changed');
    // The backup ran; nothing after it did: no stop, switch, migrate or start.
    expect(await unchanged()).toEqual({ ...before, log: ['backup'] });
    expect(current()).toBe(BASELINE);
  });

  it('AC1: the same wrapper fails the backup helper itself', () => {
    const result = backupHelper(configs.nativeFails!);
    expect(result.output).toContain('RESULT=failed: The backup script failed; nothing was changed');
  });

  it('AC1: a wrapper run with BackupConfig (-ConfigPath, -Reason) fails the same way', async () => {
    const before = await unchanged();
    clearLog();
    const result = deploy(
      '-ConfigPath',
      configs.nativeFailsWithConfig!,
      '-Release',
      join(sources, `materialmule-${NEXT}`),
    );
    expect(result.code, result.output).toBe(3);
    expect(await unchanged()).toEqual({ ...before, log: ['backup'] });
  });

  it.each([
    ['a script that throws', 'throws', 'Backup target unreachable'],
    ['a script that exits 5', 'exits', 'The backup script failed'],
    ['a script that writes an error', 'writesError', 'pg_dump reported an error'],
    ['a native backup command that exits 42', 'directNative', 'The backup script failed'],
  ])('AC4: %s stops the deploy with exit code 3 and changes nothing', async (_, key, message) => {
    const before = await unchanged();
    clearLog();
    const result = deploy(
      '-ConfigPath',
      configs[key]!,
      '-Release',
      join(sources, `materialmule-${NEXT}`),
    );
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain(message);
    expect(await unchanged()).toEqual({ ...before, log: ['backup'] });
  });

  it.each([
    ['a script with no native command', 'ok'],
    ['a wrapper whose native command succeeds', 'okNative'],
  ])('AC3: %s passes after an unrelated non-zero exit code', (_, key) => {
    clearLog();
    const result = backupHelper(configs[key]!);
    expect(result.output).toContain('RESULT=passed');
    expect(log()).toEqual(['backup']);
  });

  it('AC5: -WhatIf runs no backup and changes nothing', async () => {
    const before = await unchanged();
    clearLog();
    const result = deploy(
      '-ConfigPath',
      configs.nativeFails!,
      '-Release',
      join(sources, `materialmule-${NEXT}`),
      '-WhatIf',
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('What if: back up with');
    expect(await unchanged()).toEqual({ ...before, log: [] });
  });

  it('AC5: with no BackupScript, -SkipBackup still deploys (the manual-backup workflow)', async () => {
    clearLog();
    const result = deploy(
      '-ConfigPath',
      configs.none!,
      '-Release',
      join(sources, `materialmule-${NEXT}`),
      '-SkipBackup',
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Backup skipped (-SkipBackup)');
    expect(log()).toEqual([
      'stop',
      `migrate ${NEXT} postgres://fake_owner@127.0.0.1:5432/fake`,
      'start',
    ]);
    expect(current()).toBe(NEXT);
    expect(await health()).toMatchObject({ http: 200, version: NEXT });
  });

  it('AC3: a successful wrapper backup lets the deploy proceed normally', async () => {
    clearLog();
    const release = makeRelease(sources, '2.0.2-cccccc3');
    const result = deploy('-ConfigPath', configs.okNative!, '-Release', release);
    expect(result.code, result.output).toBe(0);
    expect(log()).toEqual([
      'backup',
      'stop',
      'migrate 2.0.2-cccccc3 postgres://fake_owner@127.0.0.1:5432/fake',
      'start',
    ]);
    expect(current()).toBe('2.0.2-cccccc3');
    expect(await health()).toMatchObject({ http: 200, version: '2.0.2-cccccc3' });
  });
});

describe.runIf(isWindows)('host setup helpers (MM-T20)', () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'materialmule-host-'));
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  function moduleCommand(script: string) {
    const module = psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'));
    return pwsh([
      '-Command',
      `$ErrorActionPreference = 'Stop'; Import-Module ${module}; ${script}`,
    ]);
  }

  it('writes a WinSW service definition: automatic, restarts with backoff, no password', () => {
    const configPath = join(work, 'svc.psd1');
    writeConfig(configPath, {
      InstallRoot: 'C:\\MaterialMule',
      HealthUrl: 'https://materialmule.example.internal/api/health',
      ServiceAccount: 'NT SERVICE\\MaterialMule',
    });
    const result = moduleCommand(
      `New-MaterialMuleServiceXml -Config (Get-MaterialMuleHostConfig -Path ${psString(configPath)})`,
    );
    expect(result.code, result.output).toBe(0);
    const xml = result.output;
    expect(xml).toContain('<startmode>Automatic</startmode>');
    expect(xml).toContain('<delayedAutoStart>true</delayedAutoStart>');
    expect(xml).toContain('<depend>postgresql-x64-17</depend>');
    expect(xml.match(/<onfailure action="restart"/g)).toHaveLength(3);
    expect(xml).toContain('<resetfailure>1 hour</resetfailure>');
    expect(xml).toContain('<stopparentprocessfirst>true</stopparentprocessfirst>');
    expect(xml).toContain('"C:\\MaterialMule\\current\\apps\\api\\dist\\main.js"');
    expect(xml).toContain(
      '<env name="ENV_FILE" value="C:\\MaterialMule\\config\\materialmule.env" />',
    );
    expect(xml).toContain('<logpath>C:\\MaterialMule\\logs</logpath>');
    expect(xml).toContain('<domain>NT SERVICE</domain>');
    expect(xml).toContain('<user>MaterialMule</user>');
    expect(xml).not.toMatch(/<password>/i);
  });

  it('leaves an account with a password out of the service file', () => {
    const configPath = join(work, 'svc-password.psd1');
    writeConfig(configPath, {
      InstallRoot: 'C:\\MaterialMule',
      HealthUrl: 'https://materialmule.example.internal/api/health',
      ServiceAccount: 'EXAMPLE\\svc-materialmule',
    });
    const result = moduleCommand(
      `New-MaterialMuleServiceXml -Config (Get-MaterialMuleHostConfig -Path ${psString(configPath)})`,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('<serviceaccount>');
  });

  it('rejects unknown or missing settings', () => {
    const configPath = join(work, 'bad.psd1');
    writeConfig(configPath, { InstallRoot: 'C:\\MaterialMule', HelthUrl: 'typo' });
    const result = moduleCommand(`Get-MaterialMuleHostConfig -Path ${psString(configPath)}`);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Unknown setting 'HelthUrl'");
  });

  it('reports PostgreSQL listening beyond localhost or open in pg_hba.conf (AC5)', () => {
    const open = join(work, 'pg-open');
    mkdirSync(open);
    writeFileSync(join(open, 'postgresql.conf'), "listen_addresses = '*'\nport = 5432\n");
    writeFileSync(
      join(open, 'pg_hba.conf'),
      [
        '# TYPE DATABASE USER ADDRESS METHOD',
        'host all all 127.0.0.1/32 scram-sha-256',
        'host all all ::1/128 scram-sha-256',
        'host all all 0.0.0.0/0 trust',
      ].join('\n'),
    );
    const closed = join(work, 'pg-closed');
    mkdirSync(closed);
    writeFileSync(
      join(closed, 'postgresql.conf'),
      "#listen_addresses = '*'\nlisten_addresses = 'localhost'\n",
    );
    writeFileSync(
      join(closed, 'pg_hba.conf'),
      'host all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n',
    );

    const openResult = moduleCommand(
      `Test-MaterialMuleDatabaseExposure -DataDir ${psString(open)}`,
    );
    expect(openResult.output).toContain("listen_addresses includes '*'");
    expect(openResult.output).toContain('pg_hba.conf allows host connections from 0.0.0.0/0');
    expect(openResult.output).toContain('pg_hba.conf trusts 0.0.0.0/0 without a password');

    const closedResult = moduleCommand(
      `(Test-MaterialMuleDatabaseExposure -DataDir ${psString(closed)}).Count`,
    );
    expect(closedResult.output.trim()).toBe('0');
  });

  it('previews the host setup with -WhatIf without creating or changing anything', () => {
    const root = join(work, 'never-created');
    const pgData = join(work, 'pg-whatif');
    mkdirSync(pgData);
    writeFileSync(join(pgData, 'postgresql.conf'), "listen_addresses = '*'\n");
    const configPath = join(work, 'install.psd1');
    writeConfig(configPath, {
      InstallRoot: root,
      ServiceName: 'MaterialMuleT20TestNoSuchService',
      HealthUrl: 'https://materialmule.example.internal/api/health',
      ServiceAccount: 'NT SERVICE\\MaterialMuleT20TestNoSuchService',
      PostgresServiceName: 'MaterialMuleT20TestNoSuchPostgres',
      PostgresDataDir: pgData,
    });
    const result = pwsh([
      '-File',
      join(SCRIPTS, 'Install-MaterialMuleHost.ps1'),
      '-ConfigPath',
      configPath,
      '-WhatIf',
    ]);
    expect(result.code, result.output).toBe(0);
    expect(existsSync(root)).toBe(false);
    for (const step of [
      'create folder',
      'write WinSW service configuration',
      'register Windows service',
      'replace permissions',
      'allow inbound TCP 443 from LocalSubnet on profile(s) Private',
      'set to 0 (never)',
    ]) {
      expect(result.output).toContain(step);
    }
    expect(result.output).toContain("listen_addresses includes '*'");
    expect(result.output).toContain('WinSW not found');
  });
});

// MM-T68: Test-MaterialMuleSecurity.ps1 and Install-MaterialMuleHost.ps1 -FailOnExposure. Run
// through tests/harness.ps1 with the firewall query and permission reads replaced by fakes
// (T68_FAKE_FIREWALL, T68_FAKE_ACLS), and a fake release CLI in place of the database check, so
// they need no database and read nothing from the real host.
describe.runIf(isWindows)('host security check (MM-T68)', () => {
  // A recognizable, fictional password: it must never appear in any output.
  const PASSWORD = 'T68-fake-Pa55word-not-real';
  const SERVICE_ACCOUNT = 'NT SERVICE\\MaterialMuleT68TestNoSuchService';
  const ADMINS = 'BUILTIN\\Administrators';
  const SYSTEM = 'NT AUTHORITY\\SYSTEM';

  let work: string;
  let root: string;
  let pgDirs: Record<string, string>;

  type Rule = { IdentityReference: string; FileSystemRights: string; AccessControlType: string };
  const allow = (identity: string, rights: string): Rule => ({
    IdentityReference: identity,
    FileSystemRights: rights,
    AccessControlType: 'Allow',
  });

  // What the Permissions step of Install-MaterialMuleHost.ps1 leaves on a fresh host.
  function installedAcls(): Record<string, Rule[]> {
    const full = () => [allow(ADMINS, 'FullControl'), allow(SYSTEM, 'FullControl')];
    return {
      [join(root, 'config')]: [...full(), allow(SERVICE_ACCOUNT, 'Read')],
      [join(root, 'config', 'materialmule.env')]: [
        ...full(),
        allow(SERVICE_ACCOUNT, 'Read, Synchronize'),
      ],
      [join(root, 'config', 'admin')]: full(),
      [join(root, 'config', 'admin', 'migrate.env')]: full(),
    };
  }

  let caseCount = 0;
  /** Runs Test-MaterialMuleSecurity.ps1 (or another script) with fakes for one scenario. */
  function run(
    options: {
      script?: string;
      pg?: string;
      settings?: Record<string, string>;
      acls?: Record<string, Rule[]>;
      firewall?: { DisplayName: string }[];
      db?: 'pass' | 'fail' | 'crash';
      args?: string[];
    } = {},
  ) {
    caseCount++;
    const configPath = join(work, `host.${caseCount}.psd1`);
    writeConfig(configPath, {
      InstallRoot: root,
      ServiceName: 'MaterialMuleT68TestNoSuchService',
      NodeExe: process.execPath,
      HealthUrl: 'https://materialmule.example.internal/api/health',
      ServiceAccount: SERVICE_ACCOUNT,
      PostgresServiceName: 'MaterialMuleT68TestNoSuchPostgres',
      PostgresDataDir: pgDirs[options.pg ?? 'local']!,
      ...options.settings,
    });
    const acls = join(work, `acls.${caseCount}.json`);
    writeFileSync(acls, JSON.stringify(options.acls ?? installedAcls()));
    const firewall = join(work, `firewall.${caseCount}.json`);
    writeFileSync(firewall, JSON.stringify(options.firewall ?? []));
    return pwsh(['-File', HARNESS, '-ConfigPath', configPath, ...(options.args ?? [])], {
      T68_SCRIPT: options.script ?? 'Test-MaterialMuleSecurity.ps1',
      T68_FAKE_ACLS: acls,
      T68_FAKE_FIREWALL: firewall,
      T68_FAKE_DB: options.db ?? 'pass',
    });
  }

  // The release's db/cli.js `security-check`, faked: T68_FAKE_DB picks pass, fail or crash. The
  // crash prints the env file, password included, the way a careless error message might.
  const FAKE_SECURITY_CLI = `
const { readFileSync } = require('node:fs');
const { basename } = require('node:path');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '(none)');
const mode = process.env.T68_FAKE_DB || 'pass';
if (args[0] !== 'security-check') { console.error('unexpected command ' + args[0]); process.exit(2); }
if (mode === 'crash') {
  console.error('Error: connect ECONNREFUSED with ' + readFileSync(opt('--env-file'), 'utf8'));
  process.exit(2);
}
console.log('PASS fake-db-args: env file ' + basename(opt('--env-file')) + ', app ' + opt('--app-role') +
  ', migration ' + opt('--migration-role') + ', backup ' + opt('--backup-role'));
if (mode === 'fail') {
  console.log('FAIL app-role-privileges: materialmule_app can create objects in schema public');
  process.exit(1);
}
`;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'materialmule-security-'));
    root = join(work, 'host');
    mkdirSync(join(root, 'config', 'admin'), { recursive: true });
    mkdirSync(join(root, 'current', 'apps', 'api', 'dist', 'db'), { recursive: true });
    writeFileSync(join(root, 'current', 'apps', 'api', 'dist', 'db', 'cli.js'), FAKE_SECURITY_CLI);
    writeFileSync(
      join(root, 'config', 'materialmule.env'),
      `APP_ENV=production\n# the API's own role\nDATABASE_URL="postgres://materialmule_app:${PASSWORD}@127.0.0.1:5432/fake"\n`,
    );
    writeFileSync(
      join(root, 'config', 'superuser.env'),
      `DATABASE_URL=postgres://postgres:${PASSWORD}@127.0.0.1:5432/fake\n`,
    );
    writeFileSync(
      join(root, 'config', 'owner.env'),
      `DATABASE_URL=postgres://materialmule_owner:${PASSWORD}@127.0.0.1:5432/fake\n`,
    );
    writeFileSync(
      join(root, 'config', 'admin', 'migrate.env'),
      `DATABASE_URL=postgres://materialmule_owner:${PASSWORD}@127.0.0.1:5432/fake\n`,
    );
    const scramLocal = [
      '# TYPE DATABASE USER ADDRESS METHOD',
      'local all all scram-sha-256',
      'host all all 127.0.0.1/32 scram-sha-256',
      'host all all ::1/128 scram-sha-256',
    ];
    const pg: Record<string, [string, string[]]> = {
      local: ["listen_addresses = 'localhost'", scramLocal],
      listenAll: ["listen_addresses = '*'", scramLocal],
      remoteHba: [
        "listen_addresses = 'localhost'",
        [...scramLocal, 'host all all 0.0.0.0/0 scram-sha-256'],
      ],
      md5: [
        "listen_addresses = 'localhost'",
        ['host all all 127.0.0.1/32 md5', 'host all all ::1/128 scram-sha-256'],
      ],
    };
    pgDirs = {};
    for (const [key, [conf, hba]] of Object.entries(pg)) {
      const dir = join(work, `pg-${key}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'postgresql.conf'), `${conf}\nport = 5432\n`);
      writeFileSync(join(dir, 'pg_hba.conf'), `${hba.join('\n')}\n`);
      pgDirs[key] = dir;
    }
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Every case: no secret in the output, ever. */
  function expectNoSecret(output: string) {
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toMatch(/postgres(ql)?:\/\/[^\s:]*:(?!\*\*\*@)[^\s@]+@/);
  }

  it('passes a correctly set up host and prints no secret', () => {
    const result = run({ args: ['-BackupRole', 'materialmule_backup'] });
    expect(result.code, result.output).toBe(0);
    for (const check of [
      'postgres-exposure',
      'pg-hba-auth-method',
      'firewall-5432',
      'acl-admin-config-dir',
      'acl-migration-env-file',
      'acl-config-dir',
      'acl-service-env-file',
      'service-env-database-user',
    ]) {
      expect(result.output).toContain(`PASS ${check}:`);
    }
    expect(result.output).toContain(
      'PASS fake-db-args: env file materialmule.env, app materialmule_app, migration materialmule_owner, backup materialmule_backup',
    );
    expect(result.output).not.toContain('FAIL ');
    expect(result.output).toContain('Summary: 9 passed, 0 failed, 0 skipped');
    expect(result.output).toContain('Result: PASS');
    expectNoSecret(result.output);
  });

  it('relays a crashing database check with its connection string masked', () => {
    const result = run({ db: 'crash' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('ECONNREFUSED');
    expect(result.output).toContain('postgres://materialmule_app:***@127.0.0.1:5432/fake');
    expect(result.output).toContain('Summary: 8 passed, 1 failed, 0 skipped');
    expectNoSecret(result.output);
  });

  it('skips the database with -SkipDatabase', () => {
    const result = run({ args: ['-SkipDatabase'], db: 'crash' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('SKIP database: skipped (-SkipDatabase)');
    expect(result.output).not.toContain('fake-db-args');
  });

  it.each([
    [
      'PostgreSQL listening on every address',
      { pg: 'listenAll' },
      "FAIL postgres-exposure: listen_addresses includes '*'",
    ],
    [
      'pg_hba.conf open to 0.0.0.0/0',
      { pg: 'remoteHba' },
      'FAIL postgres-exposure: pg_hba.conf allows host connections from 0.0.0.0/0',
    ],
    [
      'an md5 pg_hba.conf line',
      { pg: 'md5' },
      "FAIL pg-hba-auth-method: pg_hba.conf host line for 127.0.0.1/32 uses 'md5'; use scram-sha-256",
    ],
    [
      'a firewall rule opening 5432',
      { firewall: [{ DisplayName: 'PostgreSQL 17 (fake)' }] },
      "FAIL firewall-5432: rule 'PostgreSQL 17 (fake)' allows inbound TCP 5432; disable it",
    ],
    [
      'the service env file connecting as postgres',
      { envFile: 'superuser.env' },
      'FAIL service-env-database-user: DATABASE_URL connects as the superuser postgres; use materialmule_app',
    ],
    [
      'the service env file connecting as the migration role',
      { envFile: 'owner.env' },
      'FAIL service-env-database-user: DATABASE_URL connects as the migration role materialmule_owner',
    ],
    [
      'the database check reporting a failure',
      { db: 'fail' as const },
      'FAIL app-role-privileges: materialmule_app can create objects in schema public',
    ],
    [
      'the database check crashing',
      { db: 'crash' as const },
      'FAIL database: database check could not run (exit code 2)',
    ],
  ])(
    'fails on %s',
    (
      _,
      { envFile, ...options }: { envFile?: string } & NonNullable<Parameters<typeof run>[0]>,
      line,
    ) => {
      const settings = envFile ? { ServiceEnvFile: join(root, 'config', envFile) } : undefined;
      const result = run({ ...options, settings });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(line);
      expect(result.output).toContain('Result: FAIL');
      expectNoSecret(result.output);
    },
  );

  it('fails when the config folder is readable by Everyone', () => {
    const acls = installedAcls();
    acls[join(root, 'config')]!.push(allow('Everyone', 'ReadAndExecute, Synchronize'));
    const result = run({ acls });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(
      `FAIL acl-config-dir: ${join(root, 'config')}: Everyone can read it`,
    );
    expect(result.output).toContain('PASS acl-service-env-file:');
  });

  it('fails when the service account can open config\\admin or cannot read its env file', () => {
    const acls = installedAcls();
    acls[join(root, 'config', 'admin')]!.push(allow(SERVICE_ACCOUNT, 'Read'));
    acls[join(root, 'config', 'admin', 'migrate.env')]!.push(allow('BUILTIN\\Users', 'Read'));
    acls[join(root, 'config', 'materialmule.env')] = [allow(ADMINS, 'FullControl')];
    const result = run({ acls });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(
      `FAIL acl-admin-config-dir: ${join(root, 'config', 'admin')}: ${SERVICE_ACCOUNT.toUpperCase()} has access (Read)`,
    );
    expect(result.output).toMatch(
      /FAIL acl-migration-env-file: .*migrate\.env: BUILTIN\\Users has access/,
    );
    expect(result.output).toContain(
      `FAIL acl-service-env-file: ${join(root, 'config', 'materialmule.env')}: ${SERVICE_ACCOUNT.toUpperCase()} cannot read it`,
    );
  });

  it('evaluates the permissions of a real folder', () => {
    const dir = join(work, 'acl-real');
    mkdirSync(dir);
    const module = psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'));
    const newRule = (who: string, rights: string) =>
      `[System.Security.AccessControl.FileSystemAccessRule]::new(${who}, '${rights}', 'ContainerInherit, ObjectInherit', 'None', 'Allow')`;
    const sid = (value: string) =>
      `[System.Security.Principal.SecurityIdentifier]::new('${value}')`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module ${module}`,
      `$dir = ${psString(dir)}`,
      '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$acl = [System.Security.AccessControl.DirectorySecurity]::new()',
      '$acl.SetAccessRuleProtection($true, $false)',
      `$acl.AddAccessRule(${newRule('$me', 'FullControl')})`,
      `$acl.AddAccessRule(${newRule(sid('S-1-5-18'), 'FullControl')})`,
      `$acl.AddAccessRule(${newRule(sid('S-1-1-0'), 'Read')})`,
      'Set-Acl -LiteralPath $dir -AclObject $acl',
      "Set-Content -LiteralPath (Join-Path $dir 'f.env') -Value 'X=1'",
      "$rules = Get-MaterialMuleAclRules -Path (Join-Path $dir 'f.env')",
      "$problems = Test-MaterialMuleAcl -Rules $rules -AllowedIdentities 'S-1-5-32-544','S-1-5-18' -ForbiddenReaders 'S-1-1-0','S-1-5-11' -RequiredReader $me.Value",
      '$problems | ForEach-Object { "PROBLEM $_" }',
      "$ok = Test-MaterialMuleAcl -Rules $rules -AllowedIdentities 'S-1-5-18',$me.Value,'S-1-1-0' -RequiredReader 'S-1-5-18'",
      '"OK-COUNT $($ok.Count)"',
    ].join('\n');
    const result = pwsh(['-Command', script]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('PROBLEM Everyone can read it');
    expect(result.output).toContain('PROBLEM Everyone has access');
    expect(result.output).toMatch(/PROBLEM .+ has access \(FullControl\)/);
    expect(result.output).not.toContain('cannot read it');
    expect(result.output).toContain('OK-COUNT 0');
  });

  it('reads env files and connection strings without exposing the password', () => {
    const envFile = join(work, 'parse.env');
    writeFileSync(
      envFile,
      [
        '# comment',
        'export A=plain # trailing comment',
        "B='single quoted'",
        'DATABASE_URL="postgresql://app%5Fuser:p%40ss:word@localhost/db?sslmode=disable"',
      ].join('\n'),
    );
    const module = psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'));
    const result = pwsh([
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${module}`,
        `$v = Read-MaterialMuleEnvFile -Path ${psString(envFile)}`,
        '"A=[$($v.A)] B=[$($v.B)]"',
        '"USER=[$(Get-MaterialMuleDatabaseUrlUser -Url $v.DATABASE_URL)]"',
        '"QUERY=[$(Get-MaterialMuleDatabaseUrlUser -Url \'postgres://localhost/db?user=materialmule_app\')]"',
        '"NONE=[$(Get-MaterialMuleDatabaseUrlUser -Url \'postgres://localhost/db\')]"',
      ].join('\n'),
    ]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('A=[plain] B=[single quoted]');
    expect(result.output).toContain('USER=[app_user]');
    expect(result.output).toContain('QUERY=[materialmule_app]');
    expect(result.output).toContain('NONE=[]');
  });

  it('checks pg_hba.conf methods, including lines with a separate mask', () => {
    const dir = join(work, 'pg-mask');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'pg_hba.conf'),
      [
        'local all all trust',
        'host all all 127.0.0.1 255.255.255.255 password',
        'hostssl all all ::1/128 scram-sha-256',
        'host all all 10.0.0.0/8 reject',
      ].join('\n'),
    );
    const module = psString(join(SCRIPTS, 'MaterialMuleHosting.psm1'));
    const result = pwsh([
      '-Command',
      `$ErrorActionPreference = 'Stop'; Import-Module ${module}; Test-MaterialMulePgHbaAuthMethod -DataDir ${psString(dir)}`,
    ]);
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim().split(/\r?\n/)).toEqual([
      "pg_hba.conf host line for 127.0.0.1 uses 'password'; use scram-sha-256",
    ]);
  });

  describe('Install-MaterialMuleHost.ps1 -FailOnExposure', () => {
    const install = (pg: string, args: string[], firewall: { DisplayName: string }[] = []) =>
      run({
        script: 'Install-MaterialMuleHost.ps1',
        pg,
        firewall,
        settings: { InstallRoot: join(work, 'never-created') },
        args: [...args, '-WhatIf'],
      });

    it('still only warns without the switch', () => {
      const result = install('listenAll', []);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("WARNING: PostgreSQL: listen_addresses includes '*'");
      expect(existsSync(join(work, 'never-created'))).toBe(false);
    });

    it('fails when PostgreSQL is exposed', () => {
      const result = install('listenAll', ['-FailOnExposure']);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain('Database exposure found (-FailOnExposure)');
      expect(result.output).toContain("listen_addresses includes '*'");
      expect(existsSync(join(work, 'never-created'))).toBe(false);
    });

    it('fails on an md5 pg_hba.conf line or a firewall rule opening 5432', () => {
      const md5 = install('md5', ['-FailOnExposure']);
      expect(md5.code, md5.output).not.toBe(0);
      expect(md5.output).toContain("uses 'md5'");
      const firewall = install(
        'local',
        ['-FailOnExposure'],
        [{ DisplayName: 'PostgreSQL 17 (fake)' }],
      );
      expect(firewall.code, firewall.output).not.toBe(0);
      expect(firewall.output).toContain(
        "Firewall rule 'PostgreSQL 17 (fake)' allows inbound TCP 5432",
      );
    });

    it('succeeds with the switch when nothing is exposed', () => {
      const result = install('local', ['-FailOnExposure']);
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain('Database exposure found');
    });
  });
});
