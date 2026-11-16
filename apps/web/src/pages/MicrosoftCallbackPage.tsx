import {
  MICROSOFT_SIGN_IN_ERRORS,
  microsoftCallbackResponseSchema,
  type MicrosoftSignInError,
} from '@materialmule/shared';
import {
  ArrowLeft,
  CircleAlert,
  CircleX,
  Clock,
  Lock,
  Pause,
  RotateCw,
  Settings,
  ShieldAlert,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '../api/client';
import { useSession } from '../session/context';
import { SignInCardHeading, SignInLayout } from './AuthLayout';

/** What comes after the sentence: Try again, Back to sign in only, or wait out a pause. */
type Next = 'try' | 'back' | 'wait';

interface FailureCard {
  icon: LucideIcon;
  tone: 'muted' | 'due' | 'danger';
  next: Next;
  title: string;
  body: string;
  /** Offer the LAB form too (Microsoft sign-in isn't set up on this server). */
  lab?: boolean;
}

/**
 * One card per refusal the API reports (round 10, boards R10Callback*): a title, one plain
 * sentence and the next step. Mapped from the existing error codes only; no codes, Microsoft
 * error text or traces are ever shown.
 */
const SIGN_IN_FAILURES: Record<MicrosoftSignInError, FailureCard> = {
  cancelled: {
    icon: CircleX,
    tone: 'muted',
    next: 'try',
    title: 'Sign-in was cancelled.',
    body: 'You closed the Microsoft window or chose Cancel. Nothing was changed. You can start again.',
  },
  consent_denied: {
    icon: ShieldAlert,
    tone: 'due',
    next: 'back',
    title: 'Material Mule wasn’t given permission.',
    body: 'Microsoft asked whether Material Mule may read your name and email, and it wasn’t allowed. An administrator can approve it for the whole office; ask your Lab Manager.',
  },
  // One code covers both boards ("link expired" and "took too long or another browser"): the API
  // can't tell them apart, so the sentence names both.
  expired_attempt: {
    icon: Clock,
    tone: 'muted',
    next: 'try',
    title: 'The sign-in link expired.',
    body: 'Sign-in has to finish within a few minutes, in the same browser window it started in. Start again and finish it in one go.',
  },
  wrong_tenant: {
    icon: UserX,
    tone: 'danger',
    next: 'back',
    title: 'This account can’t sign in here.',
    body: 'Use your work Microsoft account for the office. Personal accounts and accounts from other organisations aren’t accepted.',
  },
  guest_account: {
    icon: UserX,
    tone: 'danger',
    next: 'back',
    title: 'Guest accounts can’t sign in.',
    body: 'Your account is a guest in the office’s Microsoft directory. Ask an administrator for a member account, then sign in with it.',
  },
  account_disabled: {
    icon: Lock,
    tone: 'danger',
    next: 'back',
    title: 'Your access was removed.',
    body: 'An administrator turned off your access to Material Mule. If you think this is a mistake, ask your Lab Manager.',
  },
  rate_limited: {
    icon: Pause,
    tone: 'due',
    next: 'wait',
    title: 'Too many sign-in attempts.',
    body: 'Sign-in from this computer is paused for a short while. Wait a few minutes, then try again.',
  },
  not_configured: {
    icon: Settings,
    tone: 'due',
    next: 'back',
    lab: true,
    title: 'Microsoft sign-in isn’t set up on this server.',
    body: 'An administrator turns it on on the host PC. Ask your Lab Manager to arrange it.',
  },
  sign_in_failed: {
    icon: CircleAlert,
    tone: 'danger',
    next: 'try',
    title: 'Something went wrong finishing sign-in.',
    body: 'Material Mule couldn’t finish signing you in. Try again. If it keeps happening, tell your Lab Manager.',
  },
};

const isKnownError = (code: unknown): code is MicrosoftSignInError =>
  typeof code === 'string' && (MICROSOFT_SIGN_IN_ERRORS as readonly string[]).includes(code);

function FinishingSpinner({ className }: { className?: string }) {
  return (
    <Spinner className={className} role="presentation" aria-hidden="true" aria-label={undefined} />
  );
}

/** Starts Microsoft sign-in again, asking which account (the last one may be the wrong one). */
const TRY_AGAIN_HREF = '/api/auth/microsoft/start?switch=1';

/**
 * Microsoft redirects here (`/sign-in/microsoft/callback`). The page hands the result to the API,
 * which validates it and issues the session, then moves on: access pending or where the person
 * was going. Shown in the sign-in layout (round 10).
 */
export function MicrosoftCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [error, setError] = useState<MicrosoftSignInError | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Each attempt is single-use, so never post it twice (React may run effects twice in dev).
    if (started.current) return;
    started.current = true;
    const body = {
      state: params.get('state') ?? '',
      code: params.get('code') ?? undefined,
      error: params.get('error') ?? undefined,
      errorDescription: params.get('error_description') ?? undefined,
      errorSubcode: params.get('error_subcode') ?? undefined,
    };
    void (async () => {
      try {
        const response = await apiFetch('/api/auth/microsoft/callback', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const json: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const code = (json as { code?: unknown } | null)?.code;
          setError(isKnownError(code) ? code : 'sign_in_failed');
          return;
        }
        const { next } = microsoftCallbackResponseSchema.parse(json);
        await refresh();
        void navigate(next, { replace: true });
      } catch {
        setError('sign_in_failed');
      }
    })();
  }, [params, navigate, refresh]);

  if (!error) {
    return (
      <SignInLayout busy help={false}>
        <section role="status" aria-labelledby="ms-finishing" className="flex flex-col gap-4">
          <SignInCardHeading
            id="ms-finishing"
            tone="accent"
            icon={FinishingSpinner}
            title="Finishing Microsoft sign-in…"
          >
            This takes a few seconds. Keep this window open.
          </SignInCardHeading>
        </section>
      </SignInLayout>
    );
  }

  const card = SIGN_IN_FAILURES[error];
  return (
    <SignInLayout>
      <section role="alert" aria-labelledby="ms-error-title" className="flex flex-col gap-6">
        <SignInCardHeading id="ms-error-title" icon={card.icon} tone={card.tone} title={card.title}>
          {card.body}
        </SignInCardHeading>
        <div className="flex flex-col gap-2">
          {card.next === 'try' ? (
            <>
              <Button asChild size="lg" className="w-full">
                <a href={TRY_AGAIN_HREF}>
                  <RotateCw aria-hidden="true" />
                  Try again
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full">
                <Link to="/sign-in">Back to sign in</Link>
              </Button>
            </>
          ) : null}
          {card.next === 'back' ? (
            <Button asChild size="lg" className="w-full">
              <Link to="/sign-in">
                <ArrowLeft aria-hidden="true" />
                Back to sign in
              </Link>
            </Button>
          ) : null}
          {card.next === 'wait' ? (
            <>
              <Button size="lg" variant="outline" className="w-full" disabled>
                <Pause aria-hidden="true" />
                Try again after the pause
              </Button>
              <Button asChild size="lg" variant="ghost" className="w-full">
                <Link to="/sign-in">Back to sign in</Link>
              </Button>
            </>
          ) : null}
        </div>
        {card.lab ? (
          <p className="text-sm text-muted-foreground">
            Shared receiving station?{' '}
            <Link
              to="/sign-in?method=lab"
              className="font-medium text-link underline-offset-4 hover:underline"
            >
              Sign in as LAB
            </Link>
          </p>
        ) : null}
      </section>
    </SignInLayout>
  );
}
