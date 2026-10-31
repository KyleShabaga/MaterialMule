import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// E2E_PREBUILT=1 (CI's browser jobs) starts the API from builds made earlier in the same job
// instead of rebuilding them. It refuses a build that is missing or older than its sources, so a
// stale dist from an earlier checkout can never be tested by mistake.

interface BuildOutput {
  name: string;
  output: string;
  inputs: string[];
}

const BUILDS: BuildOutput[] = [
  {
    name: '@materialmule/shared',
    output: 'packages/shared/dist/index.js',
    inputs: ['packages/shared/src'],
  },
  {
    name: '@materialmule/api',
    output: 'apps/api/dist/main.js',
    // Migrations and seed SQL are read at runtime, not built.
    inputs: ['apps/api/src'],
  },
  {
    name: '@materialmule/web',
    output: 'apps/web/dist/index.html',
    inputs: ['apps/web/src', 'apps/web/index.html', 'packages/shared/dist/index.js'],
  },
];

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

/** Throws unless every build output exists and is newer than everything it was built from. */
export function assertPrebuilt(root: string): void {
  const problems: string[] = [];
  for (const build of BUILDS) {
    const output = resolve(root, build.output);
    if (!existsSync(output)) {
      problems.push(`${build.name}: ${build.output} is missing`);
      continue;
    }
    const built = statSync(output).mtimeMs;
    const newestInput = Math.max(...build.inputs.map((input) => newestMtime(resolve(root, input))));
    if (newestInput > built)
      problems.push(`${build.name}: ${build.output} is older than its sources`);
  }
  if (problems.length > 0) {
    throw new Error(
      `E2E_PREBUILT=1 needs fresh builds (run npm run build first):\n  ${problems.join('\n  ')}`,
    );
  }
}
