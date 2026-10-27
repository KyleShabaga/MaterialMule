import { describe, expect, it } from 'vitest';
import { percentile, summarise } from './stats.js';

describe('latency percentiles (MM-T19)', () => {
  it('uses the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });

  it('summarises unsorted samples', () => {
    expect(summarise([30.4, 10.2, 20.6, 1000.1])).toEqual({
      count: 4,
      p50: 21,
      p95: 1000,
      p99: 1000,
      max: 1000,
    });
  });
});
