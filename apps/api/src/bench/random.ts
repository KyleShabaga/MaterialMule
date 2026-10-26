/**
 * Seeded pseudo-random numbers for the benchmark (MM-T19). The same seed always produces the same
 * dataset and the same request sequence, on any machine and PostgreSQL version, because nothing
 * depends on the database's own random() or on Math.random().
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: a small, fast 32-bit generator; plenty for test data. Returns [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Whole number in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Cannot pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** A version-4-shaped UUID drawn from this generator, so generated IDs are reproducible. */
  uuid(): string {
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) {
      hex.push(
        Math.floor(this.next() * 256)
          .toString(16)
          .padStart(2, '0'),
      );
    }
    hex[6] = `4${hex[6]![1]}`;
    hex[8] = ((parseInt(hex[8]!, 16) & 0x3f) | 0x80).toString(16);
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

/** Default seed for `npm run bench:seed` and `npm run bench:load`. Change it only on purpose. */
export const DEFAULT_BENCH_SEED = 20261025;
