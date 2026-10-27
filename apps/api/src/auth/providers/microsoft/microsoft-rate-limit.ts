import { Injectable } from '@nestjs/common';
import { FixedWindowRateLimiter, type RateLimitDecision } from '../../rate-limiter.js';

/**
 * Requests allowed per client address and endpoint in each window (MM-T48). One sign-in is one
 * start and one callback, so this leaves room for a shared station signing several people in
 * and for retries, while stopping a script hammering Microsoft or the token exchange from here.
 */
export const MICROSOFT_SIGN_IN_LIMIT = 20;
export const MICROSOFT_SIGN_IN_WINDOW_MS = 5 * 60 * 1000;

export type MicrosoftSignInEndpoint = 'start' | 'callback';

/**
 * Per-address rate limit for `/api/auth/microsoft/start` and `/callback`. Like the LAB lockout
 * (MM-T06) it counts per client address, but it limits every request rather than failures,
 * because neither endpoint knows yet whether the attempt will succeed. Kept in memory (see
 * FixedWindowRateLimiter): no session or Microsoft data is involved, and no table is needed.
 */
@Injectable()
export class MicrosoftSignInRateLimit {
  private readonly limiters: Record<MicrosoftSignInEndpoint, FixedWindowRateLimiter> = {
    start: new FixedWindowRateLimiter(MICROSOFT_SIGN_IN_LIMIT, MICROSOFT_SIGN_IN_WINDOW_MS),
    callback: new FixedWindowRateLimiter(MICROSOFT_SIGN_IN_LIMIT, MICROSOFT_SIGN_IN_WINDOW_MS),
  };

  /** Counts one request. A request with no known address is never limited (nor counted). */
  hit(
    endpoint: MicrosoftSignInEndpoint,
    clientAddress: string | null,
    now?: number,
  ): RateLimitDecision {
    if (!clientAddress) return { allowed: true };
    return this.limiters[endpoint].hit(clientAddress, now);
  }

  reset(): void {
    for (const limiter of Object.values(this.limiters)) limiter.reset();
  }
}
