// Packs a self-contained release folder for the Windows host (TRP-T20):
//   release/trapezoid-<version>/ with the built API and web app, migrations, reference seed,
//   production node_modules (from the lockfile) and the deploy scripts, plus release.json.
// Run after `npm run verify` (it needs the builds). Copy the folder to the host and run
// deploy\windows\Deploy-Trapezoid.ps1 -Release <folder>. See docs/operations/runbook.md.
//
// Usage: node scripts/pack-release.mjs [--out <dir>] [--allow-dirty] [--skip-install]
//   --skip-install leaves out node_modules (for tests only; such a release cannot run).
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths copied into a release, relative to the repo root. Nothing else (no .env, no sources). */
export const RELEASE_FILES = [
  'package.json',
  'package-lock.json',
  '.nvmrc',
  'packages/shared/package.json',
  'packages/shared/dist',
  'apps/api/package.json',
  'apps/api/dist',
  'apps/api/migrations',
  'apps/api/seed/reference.sql',
  'apps/web/package.json',
  'apps/web/dist',
  'deploy/windows/Deploy-Trapezoid.ps1',
  'deploy/windows/Install-TrapezoidHost.ps1',
  'deploy/windows/TrapezoidHosting.psm1',
  'deploy/windows/host.config.example.psd1',
  'deploy/windows/trapezoid.env.example',
  'deploy/windows/migrate.env.example',
  // Backups, restore drills and monitoring (TRP-T21).
  'deploy/windows/TrapezoidOps.psm1',
  'deploy/windows/backup.ps1',
  'deploy/windows/restore.ps1',
  'deploy/windows/monitor.ps1',
  'deploy/windows/verify-restore.sql',
  'deploy/windows/backup.config.example.psd1',
  'scripts/check-bundle-secrets.mjs',
];

/** Builds that must exist first. */
const REQUIRED_BUILDS = [
  'packages/shared/dist/index.js',
  'apps/api/dist/main.js',
  'apps/api/dist/db/cli.js',
  'apps/web/dist/index.html',
];

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function npm(command, cwd) {
  // npm is a .cmd shim on Windows, so it runs through the shell; the command is a fixed string.
  execSync(`npm ${command}`, { cwd, stdio: 'inherit' });
}

export function releaseVersion(root = ROOT, { allowDirty = false } = {}) {
  const { version } = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
  const commit = git(['rev-parse', '--short=7', 'HEAD'], root);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root) !== '';
  if (dirty && !allowDirty) {
    throw new Error('Uncommitted changes: commit them, or pass --allow-dirty for a test build.');
  }
  return { version: `${version}-${commit}${dirty ? '-dirty' : ''}`, commit };
}

/**
 * Replaces npm's workspace links in node_modules with real copies: npm links workspaces with
 * absolute junctions, which would point back at the build machine once the folder is copied.
 */
function materializeWorkspaces(dir) {
  const scope = join(dir, 'node_modules', '@trapezoid');
  rmSync(scope, { recursive: true, force: true });
  mkdirSync(join(scope, 'shared'), { recursive: true });
  cpSync(join(dir, 'packages/shared/package.json'), join(scope, 'shared/package.json'));
  cpSync(join(dir, 'packages/shared/dist'), join(scope, 'shared/dist'), { recursive: true });
}

export function packRelease({ root = ROOT, out, allowDirty = false, skipInstall = false } = {}) {
  for (const file of REQUIRED_BUILDS) {
    if (!existsSync(join(root, file))) {
      throw new Error(`${file} is missing. Run npm run build (or npm run verify) first.`);
    }
  }
  const { version, commit } = releaseVersion(root, { allowDirty });
  const outDir = resolve(out ?? join(root, 'release'));
  const dir = join(outDir, `trapezoid-${version}`);
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists; delete it first.`);
  }
  for (const file of RELEASE_FILES) {
    cpSync(join(root, file), join(dir, file), { recursive: true });
  }
  if (!skipInstall) {
    // Production dependencies only, exactly as locked; no install scripts run.
    npm('ci --omit=dev --ignore-scripts --no-audit --no-fund', dir);
    materializeWorkspaces(dir);
  }
  const node = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const manifest = {
    version,
    commit,
    node,
    builtAt: new Date().toISOString(),
    installed: !skipInstall,
  };
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  try {
    const { dir, manifest } = packRelease({
      out: outIndex === -1 ? undefined : args[outIndex + 1],
      allowDirty: args.includes('--allow-dirty'),
      skipInstall: args.includes('--skip-install'),
    });
    console.log(`Release ${manifest.version} packed in ${dir}`);
  } catch (error) {
    console.error(`pack-release: ${error.message}`);
    process.exit(1);
  }
}
