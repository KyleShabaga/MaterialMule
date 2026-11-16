import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FORBIDDEN_EVENT, UNAUTHENTICATED_EVENT, apiFetch } from '../api/client';
import {
  SessionContext,
  UnavailableRetryContext,
  loadSession as loadSessionOnce,
  type SessionState,
  type UnavailableRetry,
  unavailableRetryDelay,
} from './context';
import { claimExpiry } from './expiry-claim';
import { rememberStation } from './station';

/** loadSession that always settles in a state, so the app can never stay on Loading (MM-T61). */
function loadSession(): Promise<SessionState> {
  return loadSessionOnce().catch(() => ({
    status: 'error',
    kind: 'unreadable',
    message: 'Material Mule couldn’t load this page. Reload the page to try again.',
  }));
}

const NO_RETRY = { attempt: 0, trying: false };

/** What the app shows and allows; a sliding expiry alone isn't a change worth re-rendering. */
function fingerprint(state: SessionState): string {
  if (state.status !== 'active' && state.status !== 'pending') return state.status;
  const { sessionExpiresAt: _expiry, ...rest } = state.me;
  return JSON.stringify([state.status, rest]);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const revalidating = useRef<Promise<void> | null>(null);
  const [retry, setRetry] = useState(NO_RETRY);
  const retrying = useRef(false);

  const refresh = useCallback(async () => {
    const next = await loadSession();
    // Back in touch: the next outage starts its back-off from the first step again.
    if (next.status !== 'error') setRetry(NO_RETRY);
    setSession(next);
  }, []);

  /**
   * MTR-11: re-read /api/me in the background after a 403 `forbidden` or when the window regains
   * focus, so a removed role's navigation goes without a reload. One request at a time; an
   * unchanged answer (or a failed one) leaves the state alone, so a page that re-fetches and is
   * refused again can't start a loop. A signed-out answer goes to a page that claimed it (the
   * receiving wizard's saved-draft sign-in, expiry-claim.ts) before the app leaves for sign-in.
   */
  const revalidate = useCallback(() => {
    if (revalidating.current) return;
    revalidating.current = loadSessionOnce()
      .then(
        (next) => {
          if (next.status === 'error') return;
          if (next.status === 'signed-out' && claimExpiry()) return;
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
    const onUnauthenticated = () => {
      if (!claimExpiry()) setSession({ status: 'signed-out' });
    };
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

  /**
   * Material Mule is unavailable (round 10): load the session again, once at a time. Nothing on
   * this computer is touched, so drafts and queued moves (IndexedDB) stay until they can be sent.
   */
  const retryNow = useCallback(() => {
    if (retrying.current) return;
    retrying.current = true;
    setRetry((current) => ({ ...current, trying: true }));
    void loadSession().then((next) => {
      retrying.current = false;
      setRetry((current) =>
        next.status === 'error' ? { attempt: current.attempt + 1, trying: false } : NO_RETRY,
      );
      setSession(next);
    });
  }, []);

  const unavailable = session.status === 'error';
  useEffect(() => {
    if (!unavailable || retry.trying) return;
    const timer = window.setTimeout(retryNow, unavailableRetryDelay(retry.attempt));
    return () => window.clearTimeout(timer);
  }, [unavailable, retry.attempt, retry.trying, retryNow]);

  const retryValue = useMemo<UnavailableRetry | null>(
    () =>
      unavailable
        ? {
            attempt: retry.attempt,
            nextDelayMs: unavailableRetryDelay(retry.attempt),
            trying: retry.trying,
            retryNow,
          }
        : null,
    [unavailable, retry.attempt, retry.trying, retryNow],
  );

  const signOut = useCallback(async (nextPath = '/sign-in') => {
    // A deliberate sign-out isn't an expiry, so don't show the LAB expiry message next time.
    rememberStation(false);
    await apiFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    window.location.assign(nextPath);
  }, []);

  const value = useMemo(() => ({ session, refresh, signOut }), [session, refresh, signOut]);
  return (
    <SessionContext.Provider value={value}>
      <UnavailableRetryContext.Provider value={retryValue}>
        {children}
      </UnavailableRetryContext.Provider>
    </SessionContext.Provider>
  );
}
