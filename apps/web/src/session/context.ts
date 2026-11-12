import { meResponseSchema, type MeResponse } from '@materialmule/shared';
import { createContext, useContext } from 'react';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | {
      status: 'error';
      message: string;
      /**
       * Why: the server couldn't be reached at all, it answered with a failure, or its answer
       * couldn't be read. Absent on states built before the kind existed (treated as unreachable).
       */
      kind?: SessionErrorKind;
    }
  | { status: 'pending'; me: MeResponse }
  | { status: 'active'; me: MeResponse };

export type SessionErrorKind = 'unreachable' | 'server' | 'unreadable';

export interface SessionContextValue {
  session: SessionState;
  refresh(): Promise<void>;
  /** Ends the session and reloads, so no previous user's data survives in memory. */
  signOut(nextPath?: string): Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

const UNREADABLE: SessionState = {
  status: 'error',
  kind: 'unreadable',
  message: 'Material Mule sent an answer this page can’t read. Reload the page to try again.',
};

export async function loadSession(): Promise<SessionState> {
  let response: Response;
  try {
    response = await fetch('/api/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return {
      status: 'error',
      kind: 'unreachable',
      message: 'Material Mule couldn’t be reached. Check the connection, then reload the page.',
    };
  }
  if (response.status === 401) {
    return { status: 'signed-out' };
  }
  if (!response.ok) {
    return {
      status: 'error',
      kind: 'server',
      message:
        'The server had a problem. Reload the page in a minute; if it keeps happening, tell your administrator.',
    };
  }
  // A successful answer can still be unreadable: empty, an HTML page from a proxy, malformed or
  // cut off while being read. Each ends in the same recoverable error, never an endless Loading.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return UNREADABLE;
  }
  const parsed = meResponseSchema.safeParse(body);
  if (!parsed.success) {
    return UNREADABLE;
  }
  return parsed.data.status === 'pending'
    ? { status: 'pending', me: parsed.data }
    : { status: 'active', me: parsed.data };
}

/**
 * While the session can't be loaded (Material Mule is unavailable), SessionProvider tries again by
 * itself after 5, 10 and 20 seconds, then every 30 seconds (round 10). This is only the retry of a
 * failed page load; it has nothing to do with how long a session lasts (D38, deferred).
 */
export interface UnavailableRetry {
  /** Retries already made since the server became unreachable. */
  attempt: number;
  /** Wait before the next automatic retry, in milliseconds. */
  nextDelayMs: number;
  /** A retry is in flight (automatic or Try again). */
  trying: boolean;
  /** Try again now; ignored while a retry is in flight. */
  retryNow(): void;
}

/** Automatic retries while unavailable: 5, 10 and 20 seconds, then every 30 seconds. */
export const UNAVAILABLE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;
export const UNAVAILABLE_RETRY_EVERY_MS = 30_000;

/** The wait before automatic retry number `attempt` (0-based). */
export function unavailableRetryDelay(attempt: number): number {
  return UNAVAILABLE_RETRY_DELAYS_MS[attempt] ?? UNAVAILABLE_RETRY_EVERY_MS;
}

export const UnavailableRetryContext = createContext<UnavailableRetry | null>(null);

/** The retry state while unavailable, or null (no provider, or the session isn't in error). */
export function useUnavailableRetry(): UnavailableRetry | null {
  return useContext(UnavailableRetryContext);
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}

/** The signed-in, approved user. Only call inside routes guarded by RequireActiveSession. */
export function useMe(): MeResponse {
  const { session } = useSession();
  if (session.status !== 'active') {
    throw new Error('useMe called without an active session');
  }
  return session.me;
}
