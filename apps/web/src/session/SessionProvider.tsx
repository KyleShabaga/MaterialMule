import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FORBIDDEN_EVENT, UNAUTHENTICATED_EVENT, apiFetch } from '../api/client';
import { SessionContext, loadSession as loadSessionOnce, type SessionState } from './context';
import { rememberStation } from './station';

/** loadSession that always settles in a state, so the app can never stay on Loading (MM-T61). */
function loadSession(): Promise<SessionState> {
  return loadSessionOnce().catch(() => ({
    status: 'error',
    message: 'Material Mule couldn’t load this page. Reload the page to try again.',
  }));
}

/** What the app shows and allows; a sliding expiry alone isn't a change worth re-rendering. */
function fingerprint(state: SessionState): string {
  if (state.status !== 'active' && state.status !== 'pending') return state.status;
  const { sessionExpiresAt: _expiry, ...rest } = state.me;
  return JSON.stringify([state.status, rest]);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const revalidating = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setSession(await loadSession());
  }, []);

  /**
   * MTR-11: re-read /api/me in the background after a 403 `forbidden` or when the window regains
   * focus, so a removed role's navigation goes without a reload. One request at a time; an
   * unchanged answer (or a failed one) leaves the state alone, so a page that re-fetches and is
   * refused again can't start a loop.
   */
  const revalidate = useCallback(() => {
    if (revalidating.current) return;
    revalidating.current = loadSessionOnce()
      .then(
        (next) => {
          if (next.status === 'error') return;
          setSession((current) => {
            if (current.status !== 'active' && current.status !== 'pending') return current;
            return fingerprint(next) === fingerprint(current) ? current : next;
          });
        },
        () => undefined,
      )
      .finally(() => {
        revalidating.current = null;
      });
  }, []);

  useEffect(() => {
    let active = true;
    void loadSession().then((next) => {
      if (active) setSession(next);
    });
    // Any API call that finds the session gone flips the app to signed-out.
    const onUnauthenticated = () => setSession({ status: 'signed-out' });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    window.addEventListener(FORBIDDEN_EVENT, revalidate);
    window.addEventListener('focus', revalidate);
    return () => {
      active = false;
      window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
      window.removeEventListener(FORBIDDEN_EVENT, revalidate);
      window.removeEventListener('focus', revalidate);
    };
  }, [revalidate]);

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
