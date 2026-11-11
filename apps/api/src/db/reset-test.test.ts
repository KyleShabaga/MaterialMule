import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ResetRefusedError, assertResettable, resetTestDatabase } from './reset-test.js';

// MM-T85 / review fix #110: reset-test drops the public schema, so it refuses anything but a
// designated test database (materialmule_test or materialmule_test_<suffix>). Only the guard is
// exercised here; the reset itself runs before every E2E run (playwright.config.ts).
describe('reset-test guard (MM-T85, #110)', () => {
  it('allows APP_ENV=test against every designated test database, including each lane', () => {
    for (const database of [
      'materialmule_test',
      'materialmule_test_t07',
      'materialmule_test_t55',
      'materialmule_test_c3',
      'materialmule_test_c4',
      'materialmule_test_c5',
      'materialmule_test_c6',
      'materialmule_test_c7',
    ]) {
      expect(() => assertResettable('test', database)).not.toThrow();
    }
  });

  it('refuses near-miss names that merely contain "test", even with APP_ENV=test', () => {
    for (const database of [
      'materials_testing_prod',
      'materialmule_testing',
      'materialmule_test-prod',
      'materialmule_test_',
      'materialmule_test__x',
      'materialmule_test_Prod',
      'prod_materialmule_test',
      'materialmule_prod_test',
      'MaterialMule_TEST',
      'test',
      'materialmule_dev',
      'materialmule',
      'postgres',
      ' materialmule_test',
      'materialmule_test\n',
    ]) {
      expect(() => assertResettable('test', database), database).toThrow(ResetRefusedError);
    }
  });

  it('refuses outside APP_ENV=test, even for a test database', () => {
    for (const appEnv of ['development', 'production'] as const) {
      expect(() => assertResettable(appEnv, 'materialmule_test')).toThrow(ResetRefusedError);
    }
  });

  it('never names the database in its message', () => {
    expect(() => assertResettable('test', 'materials_testing_prod')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('materials_testing_prod') }),
    );
  });

  it('checks the connected database and refuses before any destructive SQL', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (/current_database\(\)/.test(sql)) return { rows: [{ name: 'materials_testing_prod' }] };
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;
    await expect(resetTestDatabase(pool, { appEnv: 'test' })).rejects.toThrow(ResetRefusedError);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/current_database\(\)/);
    expect(statements.some((sql) => /DROP/i.test(sql))).toBe(false);
  });

  it('refuses outside APP_ENV=test before any destructive SQL, whatever the database', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ name: 'materialmule_test' }] }));
    const pool = { query } as unknown as Pool;
    await expect(resetTestDatabase(pool, { appEnv: 'production' })).rejects.toThrow(
      ResetRefusedError,
    );
    expect(query.mock.calls.some(([sql]) => /DROP/i.test(String(sql)))).toBe(false);
  });
});
