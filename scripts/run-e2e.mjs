// `npm run test:e2e [-- <playwright args>]`. Builds packages/shared (the E2E specs import it), then
// runs Playwright, which builds the web app and the API itself (playwright.config.ts).
//
// With E2E_PREBUILT=1 nothing is rebuilt: Playwright checks that the existing builds are fresh and
// serves them as they are. Rebuilding shared here first would give it a newer timestamp than the
// web build made from it, so a current build would be refused as stale (review fix #111).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The commands `npm run test:e2e` runs, in order, for this environment and these arguments. */
export function e2eCommands(env, args) {
  const playwright = { command: 'npx', args: ['playwright', 'test', ...args] };
  if (env.E2E_PREBUILT === '1') return [playwright];
  return [{ command: 'npm', args: ['run', 'build:shared'] }, playwright];
}

function main() {
  for (const step of e2eCommands(process.env, process.argv.slice(2))) {
    // shell: true resolves npm.cmd / npx.cmd on Windows; arguments are passed through unchanged
    // except for quoting, so `--grep @critical` reaches Playwright as two arguments.
    const quoted = step.args.map((arg) => (/^[\w@./:=,-]+$/.test(arg) ? arg : JSON.stringify(arg)));
    const result = spawnSync(`${step.command} ${quoted.join(' ')}`, {
      stdio: 'inherit',
      shell: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
