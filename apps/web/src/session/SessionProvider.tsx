import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UNAUTHENTICATED_EVENT, apiFetch } from '../api/client';
import { SessionContext, loadSession as loadSessionOnce, type SessionState } from './context';
import { rememberStation } from './station';

/** loadSession that always settles in a state, so the app can never stay on Loading (MM-T61). */
function loadSession(): Promise<SessionState> {
  return loadSessionOnce().catch(() => ({
    status: 'error',
    message: 'Material Mule couldn’t load this page. Reload the page to try again.',
  }));
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    setSession(await loadSession());
  }, []);

  useEffect(() => {
    let active = true;
    void loadSession().then((next) => {
      if (active) setSession(next);
    });
    // Any API call that finds the session gone flips the app to signed-out.
    const onUnauthenticated = () => setSession({ status: 'signed-out' });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => {
      active = false;
      window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    };
  }, []);

  useEffect(() => {
    if (session.status === 'active') {
      rememberStation(session.me.accountType === 'shared_lab');
    }
  }, [session]);

  const signOut = useCallback(async (nextPath = '/sign-in') => {
    // A deliberate sign-out isn't an expiry, so don't show the LAB expiry message next time.
    rememberStation(false);
    await apiFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    window.location.assign(nextPath);
  }, []);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
