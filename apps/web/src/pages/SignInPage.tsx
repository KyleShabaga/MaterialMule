import { authProvidersResponseSchema, type AuthProvidersResponse } from '@materialmule/shared';
import { CircleAlert, Clock, FlaskConical, Info, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { safeReturnTo } from '../lib/return-to';
import { useSession } from '../session/context';
import { isLabStationComputer, stationKind, wasLabStation } from '../session/station';
import { SignInLayout } from './AuthLayout';
import { LabSignInForm } from './LabSignInForm';

export const LAB_EXPIRED_MESSAGE =
  'The LAB session has expired. Your draft is saved. Sign in to confirm.';
export const SESSION_ENDED_MESSAGE =
  'Your session has ended. Sign in to continue where you left off.';
export const OPTIONS_FAILED_TITLE = 'Sign-in options couldn’t load.';
export const OPTIONS_FAILED_NEXT =
  'Check that this computer is on the office network, then try again. If it keeps failing, tell your Lab Manager.';
export const NO_METHOD_TITLE = 'No sign-in method is set up on this server yet.';
export const NO_METHOD_NEXT =
  'An administrator turns on Microsoft sign-in or the LAB account on the host PC. Ask your Lab Manager to arrange it.';

type Providers = AuthProvidersResponse | 'error' | null;

/** `?method=lab|microsoft` picks the form explicitly; otherwise the computer's kind decides. */
type Method = 'lab' | 'microsoft';

async function loadProviders(): Promise<AuthProvidersResponse> {
  const response = await fetch('/api/auth/providers', { headers: { accept: 'application/json' } });
  return authProvidersResponseSchema.parse(await response.json());
}

/**
 * Sign in (STRATA-17, 18, 67). A normal computer opens on Microsoft sign-in with a link to the LAB
 * form; the computer marked as the LAB station opens straight on the LAB form with a link back.
 * Every state keeps the "Sign in" h1 above its alert. Nothing here shows a session end time (D38).
 */
export function SignInPage() {
  const { session, refresh } = useSession();
  const [labExpired] = useState(() => wasLabStation());
  const [isStation] = useState(() => isLabStationComputer());
  const [defaultMethod] = useState<Method>(() => (stationKind() === 'lab' ? 'lab' : 'microsoft'));
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const [providers, setProviders] = useState<Providers>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void loadProviders().then(
      (value) => active && setProviders(value),
      () => active && setProviders('error'),
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  const tryAgain = useCallback(() => {
    setProviders(null);
    setAttempt((n) => n + 1);
  }, []);

  if (session.status === 'active') {
    return <Navigate to={returnTo} replace />;
  }
  if (session.status === 'pending') {
    return <Navigate to="/access-pending" replace />;
  }

  // Links between the two forms keep everything else in the address (returnTo, switch, expired).
  const methodHref = (method: Method) => {
    const next = new URLSearchParams(params);
    next.set('method', method);
    return `/sign-in?${next.toString()}`;
  };
  const testHref = `/sign-in/test?returnTo=${encodeURIComponent(returnTo)}`;
  const ready = providers && providers !== 'error' ? providers : null;
  const asked = params.get('method');
  const wanted: Method = asked === 'lab' || asked === 'microsoft' ? asked : defaultMethod;
  // Only offer a form the server has; fall back to the other one.
  const method: Method | null = !ready
    ? null
    : wanted === 'lab'
      ? ready.lab
        ? 'lab'
        : ready.microsoft
          ? 'microsoft'
          : null
      : ready.microsoft
        ? 'microsoft'
        : ready.lab
          ? 'lab'
          : null;
  const noMethod = !!ready && !ready.microsoft && !ready.lab && !ready.test;
  const ended = labExpired ? 'lab' : params.get('expired') ? 'session' : null;

  return (
    <SignInLayout
      busy={providers === null}
      beforeFooter={
        ready?.test ? (
          <Button asChild variant="outline" size="sm" className="self-start">
            <Link to={testHref}>
              <FlaskConical aria-hidden="true" />
              Test sign-in (development only)
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        {method === 'microsoft' || (providers === null && defaultMethod === 'microsoft') ? (
          <p className="text-sm text-muted-foreground">
            Use your own work account. What you do is recorded under your name.
          </p>
        ) : null}
      </div>
      {ended === 'lab' ? (
        <Alert role="status" className="border-stage-due-mark/50 [&>svg]:text-stage-due-fg">
          <Clock aria-hidden="true" />
          <AlertDescription className="text-stage-due-fg">{LAB_EXPIRED_MESSAGE}</AlertDescription>
        </Alert>
      ) : null}
      {ended === 'session' ? (
        <Alert role="status">
          <Clock aria-hidden="true" />
          <AlertDescription className="text-foreground">{SESSION_ENDED_MESSAGE}</AlertDescription>
        </Alert>
      ) : null}
      {providers === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
          Loading sign-in options…
        </p>
      ) : null}
      {providers === 'error' ? (
        <>
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">{OPTIONS_FAILED_TITLE}</AlertTitle>
            <AlertDescription>{OPTIONS_FAILED_NEXT}</AlertDescription>
          </Alert>
          <Button variant="outline" className="w-full" onClick={tryAgain}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </>
      ) : null}
      {noMethod ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle className="line-clamp-none">{NO_METHOD_TITLE}</AlertTitle>
          <AlertDescription>{NO_METHOD_NEXT}</AlertDescription>
        </Alert>
      ) : null}
      {ready && method === 'microsoft' ? (
        <>
          <Button asChild size="lg" className="w-full">
            <a
              // With ?switch=1, Microsoft must ask which account (shared devices).
              href={`/api/auth/microsoft/start?returnTo=${encodeURIComponent(returnTo)}${
                params.get('switch') ? '&switch=1' : ''
              }`}
            >
              <MicrosoftLogo />
              Sign in with Microsoft
            </a>
          </Button>
          {ready.lab ? (
            <>
              <Separator />
              <p className="text-sm text-muted-foreground">
                Shared receiving station?{' '}
                <Link
                  to={methodHref('lab')}
                  replace
                  className="font-medium text-link underline-offset-4 hover:underline"
                >
                  Sign in as LAB
                </Link>
              </p>
            </>
          ) : null}
        </>
      ) : null}
      {ready && method === 'lab' ? (
        <>
          <LabSignInForm onSignedIn={refresh} isStation={isStation} />
          {ready.microsoft ? (
            <>
              <Separator />
              <p className="text-sm text-muted-foreground">
                Not the station?{' '}
                <Link
                  to={methodHref('microsoft')}
                  replace
                  className="font-medium text-link underline-offset-4 hover:underline"
                >
                  Sign in with your Microsoft account instead
                </Link>
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </SignInLayout>
  );
}

/**
 * Microsoft's four squares, as on its own sign-in buttons: the one non-Lucide mark (DESIGN.md).
 * Decorative: the text names it.
 */
export function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
