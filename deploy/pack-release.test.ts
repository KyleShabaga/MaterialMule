// Tests for scripts/pack-release.mjs (TRP-T20) against a throwaway git repository, so they need
// no build and no network (--skip-install leaves out node_modules).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { packRelease, RELEASE_FILES } from '../scripts/pack-release.mjs';

const MODULE = resolve(import.meta.dirname, 'windows', 'TrapezoidHosting.psm1');

function write(root: string, path: string, content = 'x') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

describe('pack-release (TRP-T20)', () => {
  let repo: string;
  let out: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'trapezoid-pack-'));
    out = join(repo, 'release');
    for (const file of RELEASE_FILES as string[]) {
      if (/\.\w+$/.test(file)) write(repo, file, '{}');
    }
    write(repo, 'apps/api/package.json', JSON.stringify({ version: '0.4.2' }));
    write(repo, '.nvmrc', '24\n');
    write(repo, 'packages/shared/dist/index.js');
    write(repo, 'apps/api/dist/main.js');
    write(repo, 'apps/api/dist/db/cli.js');
    write(repo, 'apps/api/migrations/0001_initial_schema.sql');
    write(repo, 'apps/web/dist/index.html');
    // Must never travel with a release.
    write(repo, 'apps/api/.env', 'SESSION_SECRET=fictional-secret-value-for-the-test');
    write(repo, 'apps/api/seed/dev.sql');
    write(repo, 'apps/api/src/main.ts');
    write(repo, '.gitignore', 'release/\n.env\ndist/\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('packs the builds, migrations and deploy scripts under a version with the commit', () => {
    const commit = git(repo, 'rev-parse', '--short=7', 'HEAD');
    const { dir, manifest } = packRelease({ root: repo, out, skipInstall: true });
    expect(manifest.version).toBe(`0.4.2-${commit}`);
    expect(dir).toBe(join(out, `trapezoid-0.4.2-${commit}`));
    for (const file of [
      'apps/api/dist/main.js',
      'apps/api/dist/db/cli.js',
      'apps/api/migrations/0001_initial_schema.sql',
      'apps/api/seed/reference.sql',
      'apps/web/dist/index.html',
      'deploy/windows/Deploy-Trapezoid.ps1',
      'deploy/windows/backup.ps1',
      'deploy/windows/restore.ps1',
      'deploy/windows/verify-restore.sql',
      'scripts/check-bundle-secrets.mjs',
      'release.json',
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'))).toMatchObject({
      version: manifest.version,
      commit,
    });
  });

  it('never includes env files, development fixtures or sources', () => {
    const dir = join(out, `trapezoid-0.4.2-${git(repo, 'rev-parse', '--short=7', 'HEAD')}`);
    expect(existsSync(join(dir, 'apps/api/.env'))).toBe(false);
    expect(existsSync(join(dir, 'apps/api/seed/dev.sql'))).toBe(false);
    expect(existsSync(join(dir, 'apps/api/src'))).toBe(false);
  });

  it('refuses to overwrite a packed release or pack uncommitted changes', () => {
    expect(() => packRelease({ root: repo, out, skipInstall: true })).toThrow(/already exists/);
    write(repo, 'apps/api/dist/main.js', 'changed');
    write(repo, '.nvmrc', '24.1\n');
    expect(() => packRelease({ root: repo, out: join(repo, 'other'), skipInstall: true })).toThrow(
      /Uncommitted changes/,
    );
    const { manifest } = packRelease({
      root: repo,
      out: join(repo, 'other'),
      skipInstall: true,
      allowDirty: true,
    });
    expect(manifest.version).toMatch(/-dirty$/);
  });

  it.runIf(process.platform === 'win32')('produces a folder the deploy script accepts', () => {
    const dir = join(out, `trapezoid-0.4.2-${git(repo, 'rev-parse', '--short=7', 'HEAD')}`);
    const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Import-Module ${quoted(MODULE)}; (Read-TrapezoidRelease -Path ${quoted(dir)}).version`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^0\.4\.2-[0-9a-f]{7}$/);
  });
});
