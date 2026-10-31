import { describe, expect, it } from 'vitest';
import { ResetRefusedError, assertResettable } from './reset-test.js';

// MM-T85: reset-test drops the public schema, so it refuses anything but a test database. Only
// the guard is exercised here; the reset itself runs before every E2E run (playwright.config.ts).
describe('reset-test guard (MM-T85)', () => {
  it('allows APP_ENV=test against a database whose name contains "test"', () => {
    for (const database of ['materialmule_test', 'materialmule_test_t07', 'MaterialMule_TEST']) {
      expect(() => assertResettable('test', database)).not.toThrow();
    }
  });

  it('refuses a database whose name does not contain "test", even with APP_ENV=test', () => {
    for (const database of ['materialmule_dev', 'materialmule', 'postgres']) {
      expect(() => assertResettable('test', database)).toThrow(ResetRefusedError);
    }
  });

  it('refuses outside APP_ENV=test, even for a test database', () => {
    for (const appEnv of ['development', 'production'] as const) {
      expect(() => assertResettable(appEnv, 'materialmule_test')).toThrow(ResetRefusedError);
    }
  });

  it('never names the database in its message', () => {
    expect(() => assertResettable('test', 'materialmule_dev')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('materialmule_dev') }),
    );
  });
});
