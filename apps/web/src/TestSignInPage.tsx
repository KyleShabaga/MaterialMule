import { meResponseSchema, type MeResponse } from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiFetch } from './api/client';
import { safeReturnTo } from './lib/return-to';
import { ArrowRight, CircleAlert, FlaskConical, LogOut } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SignInLayout } from './pages/AuthLayout';
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
    if (response.status === 403) {
      // The person exists but is disabled or not yet approved (MM-T61).
      setError('That test person isn’t active, so they can’t sign in. Pick someone else.');
    } else if (!response.ok) {
      setError('Sign-in didn’t work. Try again.');
    }
    await refresh();
  }

  async function signOut() {
    await apiFetch('/api/auth/sign-out', { method: 'POST' });
    await refresh();
  }

  if (load.state === 'loading') {
    return (
      <SignInLayout busy help={false}>
        <p className="text-sm text-muted-foreground">Loading test identities…</p>
      </SignInLayout>
    );
  }
  if (load.state === 'unavailable') {
    return (
      <SignInLayout help={false}>
        <h1 className="text-2xl font-semibold">Test sign-in</h1>
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>Test sign-in isn’t available on this server.</AlertDescription>
        </Alert>
      </SignInLayout>
    );
  }

  const me = load.me;
  return (
    <SignInLayout wide card={false} help={false}>
      <Alert className="border-stage-due-mark/50 [&>svg]:text-stage-due-fg">
        <FlaskConical aria-hidden="true" />
        <AlertTitle className="line-clamp-none">Development and test only.</AlertTitle>
        <AlertDescription className="text-stage-due-fg">
          These are fictional people. This page doesn’t exist on the production server.
        </AlertDescription>
      </Alert>
      <Card className="gap-5 rounded-[10px] p-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Test sign-in</h1>
          <Badge variant="due">Test</Badge>
        </div>
        {me ? (
          <div className="flex flex-col gap-4" aria-label="Current identity" role="group">
            <p className="signed-in flex items-center gap-3 text-sm" aria-live="polite">
              <Avatar className="size-8" aria-hidden="true">
                <AvatarFallback className="font-mono text-[13px] font-bold">
                  {me.initials ?? '—'}
                </AvatarFallback>
              </Avatar>
              <span>
                <span className="text-muted-foreground">Signed in as</span>{' '}
                <strong>{me.displayName}</strong>
                {me.initials ? (
                  <span className="text-muted-foreground"> · {me.initials}</span>
                ) : null}{' '}
                {me.accountType === 'test' ? <Badge variant="outline">TEST</Badge> : null}
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void signOut()}>
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
              <Button asChild>
                <Link to={returnTo}>
                  Continue to Material Mule
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Not signed in.
          </p>
        )}
        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <section className="flex flex-col gap-2" aria-labelledby="test-sign-in-as">
          <div className="flex items-baseline justify-between gap-3 border-b pb-2">
            <h2 id="test-sign-in-as" className="text-base font-semibold">
              Sign in as
            </h2>
            <span className="text-[13px] text-muted-foreground">
              {load.fixtures.length} test {load.fixtures.length === 1 ? 'identity' : 'identities'}
            </span>
          </div>
          <ul className="flex flex-col divide-y">
            {load.fixtures.map((fixture) => (
              <li key={fixture.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <Button variant="outline" size="sm" onClick={() => void signInAs(fixture.key)}>
                  {fixture.displayName}
                </Button>
                <Badge variant="outline">TEST</Badge>
                {fixture.initials ? (
                  <span className="font-mono text-[13px]">{fixture.initials}</span>
                ) : null}
                <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                  {fixture.summary}
                </span>
                {me && me.displayName === fixture.displayName ? (
                  <span className="text-[13px] font-medium text-stage-storage-fg">Signed in</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <p className="text-[13px] text-muted-foreground">
          Pending applicants sign in through the mock Microsoft tenant, not here.
        </p>
      </Card>
    </SignInLayout>
  );
}
