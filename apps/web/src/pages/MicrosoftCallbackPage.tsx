import {
  MICROSOFT_SIGN_IN_ERRORS,
  microsoftCallbackResponseSchema,
  type MicrosoftSignInError,
} from '@trapezoid/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { apiFetch } from '../api/client';
import { useSession } from '../session/context';

/** What each refusal means for the person, and what they can do next. */
const SIGN_IN_ERROR_MESSAGES: Record<MicrosoftSignInError, { title: string; body: string }> = {
  wrong_tenant: {
    title: 'This Microsoft account can’t sign in here',
    body: 'Trapezoid only accepts work accounts from the company’s own Microsoft directory. Sign in with your company account, or ask IT if you think this is wrong.',
  },
  guest_account: {
    title: 'Guest accounts can’t sign in',
    body: 'This is a guest account from another organization. Trapezoid is for company staff accounts only.',
  },
  account_disabled: {
    title: 'Your access has been removed',
    body: 'An administrator has turned off your Trapezoid access. Ask an administrator if you need it back.',
  },
  cancelled: {
    title: 'Sign-in was cancelled',
    body: 'Microsoft sign-in didn’t finish, so you aren’t signed in. You can try again.',
  },
  consent_denied: {
    title: 'Permission wasn’t granted',
    body: 'Trapezoid needs permission to sign you in and read your own basic profile (User.Read). Try again and accept, or ask IT to grant consent for the company.',
  },
  expired_attempt: {
    title: 'That sign-in link has expired',
    body: 'Sign-in took too long or was opened in another browser. Start again from the sign-in page.',
  },
  not_configured: {
    title: 'Microsoft sign-in isn’t set up',
    body: 'This server has no Microsoft sign-in configuration yet.',
  },
  sign_in_failed: {
    title: 'Microsoft sign-in didn’t work',
    body: 'Something went wrong while checking your Microsoft sign-in. Try again in a moment.',
  },
};

const isKnownError = (code: unknown): code is MicrosoftSignInError =>
  typeof code === 'string' && (MICROSOFT_SIGN_IN_ERRORS as readonly string[]).includes(code);

/**
 * Microsoft redirects here (`/sign-in/microsoft/callback`). The page hands the result to the API,
 * which validates it and issues the session, then moves on: position setup, access pending or
 * where the person was going.
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
      <main className="shell" aria-busy="true">
        <p>Finishing Microsoft sign-in…</p>
      </main>
    );
  }
  const message = SIGN_IN_ERROR_MESSAGES[error];
  return (
    <main className="shell" role="alert">
      <h1>{message.title}</h1>
      <p>{message.body}</p>
      <p>
        <a className="button primary" href="/api/auth/microsoft/start?switch=1">
          Try again
        </a>{' '}
        <Link to="/sign-in">Back to sign-in</Link>
      </p>
    </main>
  );
}
