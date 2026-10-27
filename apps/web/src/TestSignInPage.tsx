import { meResponseSchema, type MeResponse } from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiFetch } from './api/client';
import { safeReturnTo } from './lib/return-to';
import { useSession } from './session/context';

interface Fixture {
  key: string;
  displayName: string;
  initials: string | null;
  roles: string[];
  summary: string;
}

type Load =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; fixtures: Fixture[]; me: MeResponse | null };

async function loadMe(): Promise<MeResponse | null> {
  const response = await apiFetch('/api/me');
  return response.ok ? meResponseSchema.parse(await response.json()) : null;
}

async function loadAll(): Promise<Load> {
  const response = await apiFetch('/api/auth/test/fixtures');
  if (!response.ok) {
    return { state: 'unavailable' };
  }
  const fixtures = (await response.json()) as Fixture[];
  return { state: 'ready', fixtures, me: await loadMe() };
}

/**
 * Development/test-only sign-in (MM-T33). The server only exposes the fixture routes when
 * ENABLE_TEST_AUTH=true outside production, so in production this page shows "unavailable".
 */
export function TestSignInPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const { refresh: refreshSession } = useSession();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));

  // Update the app-wide session before showing "Continue", so following it never races a stale
  // signed-out state into a redirect back to sign-in.
  const refresh = useCallback(async () => {
    const next = await loadAll();
    await refreshSession();
    setLoad(next);
  }, [refreshSession]);

  useEffect(() => {
    let active = true;
    void loadAll().then((next) => {
      if (active) setLoad(next);
    });
    return () => {
      active = false;
    };
  }, []);

  async function signInAs(key: string) {
    setError(null);
    // Switching identity signs out first so nothing carries over between people.
    await apiFetch('/api/auth/sign-out', { method: 'POST' });
    const response = await apiFetch('/api/auth/test/sign-in', {
      method: 'POST',
      body: JSON.stringify({ fixtureKey: key }),
    });
    if (!response.ok) {
      setError(`Sign-in failed (HTTP ${response.status}).`);
    }
    await refresh();
  }

  async function signOut() {
    await apiFetch('/api/auth/sign-out', { method: 'POST' });
    await refresh();
  }

  if (load.state === 'loading') {
    return <p className="shell">Loading test identities…</p>;
  }
  if (load.state === 'unavailable') {
    return (
      <main className="shell">
        <h1>Test sign-in</h1>
        <p role="alert">Test sign-in isn’t available on this server.</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>Test sign-in</h1>
      <p className="subtitle">Development and test only. These are fictional people.</p>
      {load.me ? (
        <p className="signed-in" aria-live="polite">
          Signed in as <strong>{load.me.displayName}</strong>{' '}
          {load.me.accountType === 'test' ? <span className="badge">TEST</span> : null}{' '}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>{' '}
          <Link className="button primary" to={returnTo}>
            Continue to Material Mule
          </Link>
        </p>
      ) : (
        <p aria-live="polite">Not signed in.</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <ul className="fixtures">
        {load.fixtures.map((fixture) => (
          <li key={fixture.key}>
            <button type="button" onClick={() => void signInAs(fixture.key)}>
              {fixture.displayName}
            </button>{' '}
            <span className="badge">TEST</span> {fixture.initials ? `${fixture.initials} · ` : ''}
            {fixture.summary}
          </li>
        ))}
      </ul>
    </main>
  );
}
