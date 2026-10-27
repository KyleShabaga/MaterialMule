// Fails if the built web bundle (or, on the host, the logs) contains server-only configuration.
// Checks fixed markers always, plus the actual values of any server env vars set in this shell
// or in the env files.
//
// Usage: node scripts/check-bundle-secrets.mjs      (repo: apps/web/dist with apps/api/.env*)
//        node scripts/check-bundle-secrets.mjs --dir <web dist> --logs <log dir> --env-file <env>
//        (production host, MM-T20; each option may repeat). Logs are checked for values only:
//        a log may name a setting ("DATABASE_URL is required") but must never hold its value.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = process.cwd();
const SERVER_KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  'TLS_PFX_PASSPHRASE',
];

function optionValues(name) {
  const args = process.argv.slice(2);
  const values = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1]) values.push(resolve(args[index + 1]));
  });
  return values;
}

const explicit = process.argv.length > 2;
const bundleDirs = explicit ? optionValues('--dir') : [join(root, 'apps', 'web', 'dist')];
const logDirs = optionValues('--logs');
const envFiles = explicit
  ? optionValues('--env-file')
  : ['.env', '.env.test'].map((file) => join(root, 'apps', 'api', file)).filter(existsSync);

for (const dir of [...bundleDirs, ...logDirs]) {
  if (!existsSync(dir)) {
    console.error(`check-bundle-secrets: ${relative(root, dir) || dir} not found.`);
    process.exit(1);
  }
}

const valueMarkers = new Map();
const envSources = [process.env];
for (const path of envFiles) {
  if (!existsSync(path)) {
    console.error(`check-bundle-secrets: env file ${path} not found.`);
    process.exit(1);
  }
  envSources.push(parseEnv(readFileSync(path, 'utf8')));
}
for (const env of envSources) {
  for (const key of SERVER_KEYS) {
    const value = env[key];
    if (value && value.length >= 8) {
      valueMarkers.set(value, `the value of ${key}`);
    }
  }
}

const bundleMarkers = new Map(valueMarkers);
for (const key of SERVER_KEYS) {
  bundleMarkers.set(key, `the name ${key}`);
}
bundleMarkers.set('postgres://', 'a PostgreSQL connection URL');
bundleMarkers.set('postgresql://', 'a PostgreSQL connection URL');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* files(path);
    } else {
      yield path;
    }
  }
}

const findings = [];
function scan(dirs, markers) {
  for (const dir of dirs) {
    for (const file of files(dir)) {
      const content = readFileSync(file, 'utf8');
      for (const [needle, description] of markers) {
        if (content.includes(needle)) {
          findings.push(`${relative(root, file) || file} contains ${description}`);
        }
      }
    }
  }
}
scan(bundleDirs, bundleMarkers);
scan(logDirs, valueMarkers);

if (findings.length > 0) {
  console.error('check-bundle-secrets: server configuration found:');
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}
console.log(
  `check-bundle-secrets: OK (${bundleMarkers.size} markers in ${bundleDirs.length} bundle folder(s), ` +
    `${valueMarkers.size} secret values in ${logDirs.length} log folder(s)).`,
);
