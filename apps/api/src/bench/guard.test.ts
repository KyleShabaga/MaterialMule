import { describe, expect, it } from 'vitest';
import { assertBenchTarget, BenchTargetRefusedError, databaseNameOf } from './guard.js';

const url = (name: string) => `postgres://bench:not-a-real-password@127.0.0.1:5432/${name}`;

describe('benchmark target guard (TRP-T19)', () => {
  it('accepts databases named for benchmarks or tests', () => {
    expect(assertBenchTarget(url('trapezoid_bench'), 'test')).toBe('trapezoid_bench');
    expect(assertBenchTarget(url('trapezoid_test_t19'), 'development')).toBe('trapezoid_test_t19');
    expect(assertBenchTarget(url('Trapezoid_BENCH_host'), 'test')).toBe('Trapezoid_BENCH_host');
  });

  it('refuses production whatever the database is called', () => {
    expect(() => assertBenchTarget(url('trapezoid_bench'), 'production')).toThrow(
      BenchTargetRefusedError,
    );
  });

  it('refuses development and production-looking database names', () => {
    for (const name of ['trapezoid', 'trapezoid_dev', 'trapezoid_prod']) {
      expect(() => assertBenchTarget(url(name), 'test')).toThrow(/must contain "bench" or "test"/);
    }
    expect(() => assertBenchTarget('postgres://u:p@127.0.0.1:5432/', 'test')).toThrow(
      /names no database/,
    );
  });

  it('never echoes the connection string', () => {
    try {
      assertBenchTarget(url('trapezoid'), 'test');
    } catch (error) {
      expect((error as Error).message).not.toContain('not-a-real-password');
    }
  });

  it('reads the name from the path only, not from query options', () => {
    expect(databaseNameOf(`${url('trapezoid_dev')}?options=-c%20search_path%3Dtest_x`)).toBe(
      'trapezoid_dev',
    );
  });
});
