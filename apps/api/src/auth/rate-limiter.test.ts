import { describe, expect, it } from 'vitest';
import { MicrosoftSignInRateLimit } from './providers/microsoft/microsoft-rate-limit.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';

describe('FixedWindowRateLimiter (MM-T48)', () => {
  it('allows `limit` requests per key and window, then refuses with the wait in seconds', () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(limiter.hit('a', t0 + i)).toEqual({ allowed: true });
    expect(limiter.hit('a', t0 + 10_000)).toEqual({ allowed: false, retryAfterSeconds: 50 });
    // A new window starts once the old one ends.
    expect(limiter.hit('a', t0 + 60_000)).toEqual({ allowed: true });
  });

  it('counts each key separately, so one busy address never blocks another', () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    limiter.hit('10.0.0.5', 0);
    limiter.hit('10.0.0.5', 0);
    expect(limiter.hit('10.0.0.5', 1).allowed).toBe(false);
    expect(limiter.hit('10.0.0.6', 1)).toEqual({ allowed: true });
  });

  it('keeps at most maxKeys windows', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, 2);
    limiter.hit('a', 0);
    limiter.hit('b', 0);
    limiter.hit('c', 0); // evicts the oldest live window ('a')
    expect(limiter.hit('a', 1)).toEqual({ allowed: true });
    expect(limiter.hit('c', 1).allowed).toBe(false);
  });

  it('reset forgets every count', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    limiter.hit('a', 0);
    limiter.reset();
    expect(limiter.hit('a', 1)).toEqual({ allowed: true });
  });
});

describe('MicrosoftSignInRateLimit (MM-T48)', () => {
  it('limits start and callback separately per address and never limits an unknown address', () => {
    const limit = new MicrosoftSignInRateLimit();
    for (let i = 0; i < 20; i += 1) expect(limit.hit('start', '10.0.0.5', 0).allowed).toBe(true);
    expect(limit.hit('start', '10.0.0.5', 0).allowed).toBe(false);
    expect(limit.hit('callback', '10.0.0.5', 0).allowed).toBe(true);
    expect(limit.hit('start', '10.0.0.6', 0).allowed).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(limit.hit('start', null, 0).allowed).toBe(true);
  });
});
