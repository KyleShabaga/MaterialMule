export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  count: number;
  resetsAt: number;
}

/**
 * Counts requests per key (e.g. a client address) in fixed windows, in memory. The API runs as
 * one Windows service process (D25), so in-process state is shared by every request; a restart
 * forgets the counts, which only ever lets a caller through sooner. Each key has its own
 * counter, so one noisy address never blocks another.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Upper bound on tracked keys, so a flood of distinct addresses can't grow memory. */
    private readonly maxKeys = 10_000,
  ) {}

  hit(key: string, now = Date.now()): RateLimitDecision {
    let window = this.windows.get(key);
    if (!window || window.resetsAt <= now) {
      this.makeRoom(now);
      window = { count: 0, resetsAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetsAt - now) / 1000) };
    }
    window.count += 1;
    return { allowed: true };
  }

  /** Forgets every count (tests start each case clean). */
  reset(): void {
    this.windows.clear();
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (window.resetsAt <= now) this.windows.delete(key);
    }
    // Still full: drop the oldest windows (Map keeps insertion order).
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}
