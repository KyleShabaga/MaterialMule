export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of an ascending list (the value at or below which p% of samples fall). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** p50/p95/p99/max in milliseconds, rounded to whole ms. */
export function summarise(latencies: readonly number[]): LatencySummary {
  const sorted = [...latencies].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
  };
}
