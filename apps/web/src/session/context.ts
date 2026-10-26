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

export async function loadSession(): Promise<SessionState> {
  let response: Response;
  try {
    response = await fetch('/api/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return { status: 'error', message: 'The API could not be reached.' };
  }
  if (response.status === 401) {
    return { status: 'signed-out' };
  }
  if (!response.ok) {
    return { status: 'error', message: `The API responded with HTTP ${response.status}.` };
  }
  const parsed = meResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return { status: 'error', message: 'The API returned an unexpected response.' };
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
