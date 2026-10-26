import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// The backup/restore tests (TRP-T21) use the test database like the API tests: TEST_DATABASE_URL,
// or else the DATABASE_URL in apps/api/.env.test.
const envTestFile = new URL('../apps/api/.env.test', import.meta.url);
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  (existsSync(envTestFile) ? parseEnv(readFileSync(envTestFile, 'utf8')).DATABASE_URL : undefined);

// Deploy script and release packing tests (TRP-T20). They spawn PowerShell 7 and Node processes,
// run one file at a time and need longer timeouts than unit tests.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
  },
});
