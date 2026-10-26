// Fails if the built web bundle contains server-only configuration.
// Checks fixed markers always, plus the actual values of any server env vars set in this shell
// or in apps/api/.env / .env.test.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnv } from 'node:util';

const root = process.cwd();
const distDir = join(root, 'apps', 'web', 'dist');
const SERVER_KEYS = ['DATABASE_URL', 'SESSION_SECRET'];

if (!existsSync(distDir)) {
  console.error(
    `check-bundle-secrets: ${relative(root, distDir)} not found. Build the web app first.`,
  );
  process.exit(1);
}

const forbidden = new Map();
for (const key of SERVER_KEYS) {
  forbidden.set(key, `the name ${key}`);
}
forbidden.set('postgres://', 'a PostgreSQL connection URL');
forbidden.set('postgresql://', 'a PostgreSQL connection URL');

const envSources = [process.env];
for (const file of ['.env', '.env.test']) {
  const path = join(root, 'apps', 'api', file);
  if (existsSync(path)) {
    envSources.push(parseEnv(readFileSync(path, 'utf8')));
  }
}
for (const env of envSources) {
  for (const key of SERVER_KEYS) {
    const value = env[key];
    if (value && value.length >= 8) {
      forbidden.set(value, `the value of ${key}`);
    }
  }
}

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
for (const file of files(distDir)) {
  const content = readFileSync(file, 'utf8');
  for (const [needle, description] of forbidden) {
    if (content.includes(needle)) {
      findings.push(`${relative(root, file)} contains ${description}`);
    }
  }
}

if (findings.length > 0) {
  console.error('check-bundle-secrets: server configuration found in the web bundle:');
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}
console.log(`check-bundle-secrets: OK (${forbidden.size} markers checked).`);
