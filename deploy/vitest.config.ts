import { defineConfig } from 'vitest/config';

// Deploy script and release packing tests (TRP-T20). They spawn PowerShell 7 and Node processes,
// run one file at a time and need longer timeouts than unit tests.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
