// Automated tests for the Windows deploy scripts (TRP-T20). They run the real PowerShell scripts
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
  const dir = join(parent, `trapezoid-${version}`);
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

describe.runIf(isWindows)('Deploy-Trapezoid.ps1 (TRP-T20)', () => {
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
    work = mkdtempSync(join(tmpdir(), 'trapezoid-deploy-'));
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
      join(root, 'config', 'trapezoid.env'),
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
      ServiceName: 'TrapezoidT20TestNoSuchService',
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
    const release = join(sources, 'trapezoid-1.0.0-aaaaaa1');
    const result = deploy('-ConfigPath', configNoBackup, '-Release', release);
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain('No BackupScript is configured');
    expect(readdirSync(join(root, 'releases'))).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('installs the first release: migrate as the migration role, start, health check', async () => {
    const release = join(sources, 'trapezoid-1.0.0-aaaaaa1');
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
      join(sources, 'trapezoid-1.0.0-aaaaaa1'),
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

describe.runIf(isWindows)('host setup helpers (TRP-T20)', () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'trapezoid-host-'));
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  function moduleCommand(script: string) {
    const module = psString(join(SCRIPTS, 'TrapezoidHosting.psm1'));
    return pwsh([
      '-Command',
      `$ErrorActionPreference = 'Stop'; Import-Module ${module}; ${script}`,
    ]);
  }

  it('writes a WinSW service definition: automatic, restarts with backoff, no password', () => {
    const configPath = join(work, 'svc.psd1');
    writeConfig(configPath, {
      InstallRoot: 'C:\\Trapezoid',
      HealthUrl: 'https://trapezoid.example.internal/api/health',
      ServiceAccount: 'NT SERVICE\\Trapezoid',
    });
    const result = moduleCommand(
      `New-TrapezoidServiceXml -Config (Get-TrapezoidHostConfig -Path ${psString(configPath)})`,
    );
    expect(result.code, result.output).toBe(0);
    const xml = result.output;
    expect(xml).toContain('<startmode>Automatic</startmode>');
    expect(xml).toContain('<delayedAutoStart>true</delayedAutoStart>');
    expect(xml).toContain('<depend>postgresql-x64-17</depend>');
    expect(xml.match(/<onfailure action="restart"/g)).toHaveLength(3);
    expect(xml).toContain('<resetfailure>1 hour</resetfailure>');
    expect(xml).toContain('<stopparentprocessfirst>true</stopparentprocessfirst>');
    expect(xml).toContain('"C:\\Trapezoid\\current\\apps\\api\\dist\\main.js"');
    expect(xml).toContain('<env name="ENV_FILE" value="C:\\Trapezoid\\config\\trapezoid.env" />');
    expect(xml).toContain('<logpath>C:\\Trapezoid\\logs</logpath>');
    expect(xml).toContain('<domain>NT SERVICE</domain>');
    expect(xml).toContain('<user>Trapezoid</user>');
    expect(xml).not.toMatch(/<password>/i);
  });

  it('leaves an account with a password out of the service file', () => {
    const configPath = join(work, 'svc-password.psd1');
    writeConfig(configPath, {
      InstallRoot: 'C:\\Trapezoid',
      HealthUrl: 'https://trapezoid.example.internal/api/health',
      ServiceAccount: 'EXAMPLE\\svc-trapezoid',
    });
    const result = moduleCommand(
      `New-TrapezoidServiceXml -Config (Get-TrapezoidHostConfig -Path ${psString(configPath)})`,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('<serviceaccount>');
  });

  it('rejects unknown or missing settings', () => {
    const configPath = join(work, 'bad.psd1');
    writeConfig(configPath, { InstallRoot: 'C:\\Trapezoid', HelthUrl: 'typo' });
    const result = moduleCommand(`Get-TrapezoidHostConfig -Path ${psString(configPath)}`);
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

    const openResult = moduleCommand(`Test-TrapezoidDatabaseExposure -DataDir ${psString(open)}`);
    expect(openResult.output).toContain("listen_addresses includes '*'");
    expect(openResult.output).toContain('pg_hba.conf allows host connections from 0.0.0.0/0');
    expect(openResult.output).toContain('pg_hba.conf trusts 0.0.0.0/0 without a password');

    const closedResult = moduleCommand(
      `(Test-TrapezoidDatabaseExposure -DataDir ${psString(closed)}).Count`,
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
      ServiceName: 'TrapezoidT20TestNoSuchService',
      HealthUrl: 'https://trapezoid.example.internal/api/health',
      ServiceAccount: 'NT SERVICE\\TrapezoidT20TestNoSuchService',
      PostgresServiceName: 'TrapezoidT20TestNoSuchPostgres',
      PostgresDataDir: pgData,
    });
    const result = pwsh([
      '-File',
      join(SCRIPTS, 'Install-TrapezoidHost.ps1'),
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
