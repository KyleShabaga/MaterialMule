import { meResponseSchema, type MeResponse } from '@materialmule/shared';
import { createContext, useContext } from 'react';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'pending'; me: MeResponse }
  | { status: 'active'; me: MeResponse };

export interface SessionContextValue {
  session: SessionState;
  refresh(): Promise<void>;
  /** Ends the session and reloads, so no previous user's data survives in memory. */
  signOut(nextPath?: string): Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

const UNREADABLE: SessionState = {
  status: 'error',
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
      message: 'Material Mule couldn’t be reached. Check the connection, then reload the page.',
    };
  }
  if (response.status === 401) {
    return { status: 'signed-out' };
  }
  if (!response.ok) {
    return {
      status: 'error',
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
