import { Injectable } from '@nestjs/common';

const MAX_ENTRIES = 1000;

/**
 * Delegated Graph access tokens from Microsoft sign-ins, keyed by app session, in server memory
 * only: never in the database, the browser or logs. Used for a profile Retry within the token's
 * lifetime (about an hour); after that, or after a restart, Retry means signing in again.
 */
@Injectable()
export class MicrosoftTokenCache {
  private readonly entries = new Map<string, { token: string; expiresAt: number }>();

  set(sessionId: string, token: string, expiresAt: Date): void {
    this.prune();
    this.entries.set(sessionId, { token, expiresAt: expiresAt.getTime() });
  }

  get(sessionId: string, now = Date.now()): string | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    // A minute's margin so the token doesn't expire mid-request.
    if (entry.expiresAt - 60_000 <= now) {
      this.entries.delete(sessionId);
      return null;
    }
    return entry.token;
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  private prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
