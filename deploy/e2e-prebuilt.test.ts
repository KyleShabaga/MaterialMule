// Review fixes #111: the E2E npm entry point (scripts/run-e2e.mjs) and the E2E_PREBUILT freshness
// check (e2e/support/prebuilt.ts), against throwaway fixture folders with controlled timestamps.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILDS, assertPrebuilt } from '../e2e/support/prebuilt';
// @ts-expect-error -- plain ESM script without type declarations
import { e2eCommands } from '../scripts/run-e2e.mjs';

const OLD = new Date('2026-01-01T00:00:00Z');
const BUILT = new Date('2026-01-02T00:00:00Z');
const LATER = new Date('2026-01-03T00:00:00Z');

function touch(root: string, path: string, time: Date) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  utimesSync(file, time, time);
}

/** A repository-shaped fixture: every input older than every output. */
function freshFixture(root: string) {
  for (const build of BUILDS) {
    for (const input of build.inputs) {
      if (input.endsWith('dist/index.js')) continue;
      // Directories get one file; files are written as is. Optional .env files are left out.
      if (input.includes('/.env')) continue;
      touch(root, /\.[a-z]+$/.test(input) ? input : join(input, 'index.ts'), OLD);
    }
  }
  for (const build of BUILDS) touch(root, build.output, BUILT);
}

describe('npm run test:e2e entry point (#111)', () => {
  it('builds shared before Playwright in an ordinary run', () => {
    expect(e2eCommands({}, ['--list'])).toEqual([
      { command: 'npm', args: ['run', 'build:shared'] },
      { command: 'npx', args: ['playwright', 'test', '--list'] },
    ]);
  });

  it('rebuilds nothing with E2E_PREBUILT=1, so a current build is not made stale', () => {
    expect(e2eCommands({ E2E_PREBUILT: '1' }, ['--grep', '@critical'])).toEqual([
      { command: 'npx', args: ['playwright', 'test', '--grep', '@critical'] },
    ]);
  });
});

describe('E2E_PREBUILT freshness check (#111)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mm-prebuilt-'));
    freshFixture(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts builds newer than all their sources and configuration', () => {
    expect(() => assertPrebuilt(root)).not.toThrow();
  });

  it('refuses a missing build', () => {
    rmSync(join(root, 'apps/api/dist/main.js'));
    expect(() => assertPrebuilt(root)).toThrow(
      /@materialmule\/api: apps\/api\/dist\/main.js is missing/,
    );
  });

  it('refuses a web build older than its sources', () => {
    touch(root, 'apps/web/src/App.tsx', LATER);
    expect(() => assertPrebuilt(root)).toThrow(/@materialmule\/web/);
  });

  it('refuses the web build when only the shared dist was rebuilt after it (the old wrapper)', () => {
    // What `npm run build:shared` before Playwright used to do in prebuilt mode.
    touch(root, 'packages/shared/dist/index.js', LATER);
    expect(() => assertPrebuilt(root)).toThrow(/@materialmule\/web/);
  });

  it.each([
    ['@materialmule/web', 'apps/web/vite.config.ts'],
    ['@materialmule/web', 'apps/web/tsconfig.json'],
    ['@materialmule/web', 'apps/web/.env.production'],
    ['@materialmule/shared', 'packages/shared/tsup.config.ts'],
    ['@materialmule/api', 'apps/api/tsconfig.build.json'],
    ['@materialmule/api', 'apps/api/nest-cli.json'],
  ])('refuses %s when only %s changed after the build', (name, config) => {
    touch(root, config, LATER);
    let message = '';
    try {
      assertPrebuilt(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`${name}:`);
    expect(message).toContain('older than its sources or build configuration');
  });

  it('refuses every build when the lockfile (dependency versions) changed after them', () => {
    touch(root, 'package-lock.json', LATER);
    expect(() => assertPrebuilt(root)).toThrow(/shared[\s\S]*api[\s\S]*web/);
  });
});
