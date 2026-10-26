import { authProvidersResponseSchema, type AuthProvidersResponse } from '@trapezoid/shared';
import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ErrorState } from '../components/ui';
import { safeReturnTo } from '../lib/return-to';
import { useSession } from '../session/context';

export function SignInPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const [providers, setProviders] = useState<AuthProvidersResponse | 'error' | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/auth/providers', { headers: { accept: 'application/json' } })
      .then(async (response) => authProvidersResponseSchema.parse(await response.json()))
      .then(
        (value) => active && setProviders(value),
        () => active && setProviders('error'),
      );
    return () => {
      active = false;
    };
  }, []);

  if (session.status === 'active') {
    return <Navigate to={returnTo} replace />;
  }
  if (session.status === 'pending') {
    return <Navigate to="/access-pending" replace />;
  }

  const testHref = `/sign-in/test?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="shell sign-in">
      <h1>Trapezoid</h1>
      <p className="subtitle">Sample receiving and storage tracking</p>
      {params.get('expired') ? (
        <p role="status">Your session has ended. Sign in to continue where you left off.</p>
      ) : null}
      {providers === null ? <p>Loading sign-in options…</p> : null}
      {providers === 'error' ? <ErrorState message="Sign-in options couldn't load." /> : null}
      {providers && providers !== 'error' ? (
        <div className="sign-in-options">
          {providers.microsoft ? (
            <a
              className="button primary"
              href={`/api/auth/microsoft/start?returnTo=${encodeURIComponent(returnTo)}`}
            >
              Sign in with Microsoft
            </a>
          ) : null}
          {providers.lab ? (
            <section className="card" aria-labelledby="lab-sign-in">
              <h2 id="lab-sign-in">Shared receiving station (LAB)</h2>
              <p>LAB sign-in arrives with TRP-T06.</p>
              <p className="field-hint">Forgot password? Ask an administrator.</p>
            </section>
          ) : null}
          {providers.test ? (
            <Link className="button" to={testHref}>
              Test sign-in (development only)
            </Link>
          ) : null}
          {!providers.microsoft && !providers.lab && !providers.test ? (
            <p role="alert">No sign-in method is set up on this server yet.</p>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
