import { describe, expect, it } from 'vitest';
import { assertBenchTarget, BenchTargetRefusedError, databaseNameOf } from './guard.js';

const url = (name: string) => `postgres://bench:not-a-real-password@127.0.0.1:5432/${name}`;

describe('benchmark target guard (MM-T19)', () => {
  it('accepts databases named for benchmarks or tests', () => {
    expect(assertBenchTarget(url('materialmule_bench'), 'test')).toBe('materialmule_bench');
    expect(assertBenchTarget(url('materialmule_test_t19'), 'development')).toBe(
      'materialmule_test_t19',
    );
    expect(assertBenchTarget(url('MaterialMule_BENCH_host'), 'test')).toBe(
      'MaterialMule_BENCH_host',
    );
  });

  it('refuses production whatever the database is called', () => {
    expect(() => assertBenchTarget(url('materialmule_bench'), 'production')).toThrow(
      BenchTargetRefusedError,
    );
  });

  it('refuses development and production-looking database names', () => {
    for (const name of ['materialmule', 'materialmule_dev', 'materialmule_prod']) {
      expect(() => assertBenchTarget(url(name), 'test')).toThrow(/must contain "bench" or "test"/);
    }
    expect(() => assertBenchTarget('postgres://u:p@127.0.0.1:5432/', 'test')).toThrow(
      /names no database/,
    );
  });

  it('never echoes the connection string', () => {
    try {
      assertBenchTarget(url('materialmule'), 'test');
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-real-password');
    }
  });

  it('reads the name from the path only, not from query options', () => {
    expect(databaseNameOf(`${url('materialmule_dev')}?options=-c%20search_path%3Dtest_x`)).toBe(
      'materialmule_dev',
    );
  });
});
