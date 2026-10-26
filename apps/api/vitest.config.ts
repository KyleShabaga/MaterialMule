import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Database tests use TEST_DATABASE_URL. Unless it's set explicitly (as in CI), fall back to the
// DATABASE_URL in apps/api/.env.test so `npm test` covers the database locally with no extra setup.
const envTestFile = new URL('./.env.test', import.meta.url);
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  (existsSync(envTestFile) ? parseEnv(readFileSync(envTestFile, 'utf8')).DATABASE_URL : undefined);

// SWC (not esbuild) so Nest decorator metadata is emitted under test.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
  },
});
