import { LAB_USERNAME, signInLockedResponseSchema } from '@materialmule/shared';
import { CircleAlert, Pause } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiFetch } from '../api/client';

type SignInFailure =
  /** 401: shown under Password, which is marked invalid. */
  | { kind: 'wrong'; message: string }
  /** 429: too many failed attempts; Sign in as LAB stays disabled until the pause ends. */
  | { kind: 'paused'; message: string; retryAfterMs: number }
  /** Anything else: a red alert above the form. */
  | { kind: 'other'; message: string };

export const WRONG_PASSWORD_MESSAGE = 'The username or password is incorrect.';

/** Messages for each sign-in failure. None repeats what was typed. */
async function labSignInError(response: Response): Promise<SignInFailure | null> {
  if (response.ok) return null;
  if (response.status === 401) return { kind: 'wrong', message: WRONG_PASSWORD_MESSAGE };
  if (response.status === 429) {
    const body = signInLockedResponseSchema.safeParse(await response.json().catch(() => null));
    const seconds = body.success ? body.data.retryAfterSeconds : 15 * 60;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return {
      kind: 'paused',
      message: `Too many failed attempts. Sign-in is paused for about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retryAfterMs: Math.max(1, seconds) * 1000,
    };
  }
  if (response.status === 400)
    return { kind: 'other', message: 'Enter the username and password.' };
  return { kind: 'other', message: 'Sign-in didn’t work. Try again.' };
}

/** The hint on the computer an administrator marked as the LAB station (STRATA-18). */
export const LAB_STATION_HINT =
  'This computer is set up as the LAB station. After signing in, pick your own name so your work is recorded under it.';

/** The hint when LAB is chosen on any other computer. */
export const LAB_HINT =
  'For the shared receiving computers. After signing in, pick your own name so your work is recorded under it.';

/**
 * The pause counts failed attempts for the LAB account and for this computer's address. An
 * administrator's password reset clears only the account count and signs out every LAB computer
 * (MM-T06), so it can't promise to end this computer's pause (MM-T50).
 */
export const PAUSED_HELP =
  'Wait until the pause ends, then sign in with the correct password. If the password is lost, ask an administrator to reset it. A reset signs out every LAB computer and may not end the pause on this computer.';

/**
 * Shared receiving station sign-in (MM-T06, STRATA-17). LAB is an app-managed account, not a
 * Microsoft account; its password is set by an administrator. After it signs in, the app sends the
 * station to "Who is working here?" (the station agent's guard).
 */
export function LabSignInForm({
  onSignedIn,
  isStation,
}: {
  onSignedIn: () => Promise<void>;
  /** This computer is the marked LAB station: the hint says so. */
  isStation: boolean;
}) {
  const [username, setUsername] = useState(LAB_USERNAME);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const userId = `${ids}-user`;
  const passwordId = `${ids}-password`;
  const passwordErrorId = `${ids}-password-error`;
  const headingId = `${ids}-title`;
  const paused = error?.kind === 'paused';
  const retryAfterMs = paused ? error.retryAfterMs : 0;

  // The pause ends by itself; then Sign in as LAB works again (the alert stays until the next try).
  useEffect(() => {
    if (!retryAfterMs) return;
    const timer = window.setTimeout(
      () =>
        setError((current) =>
          current?.kind === 'paused' ? { ...current, retryAfterMs: 0 } : current,
        ),
      retryAfterMs,
    );
    return () => window.clearTimeout(timer);
  }, [retryAfterMs]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (retryAfterMs) return;
    setBusy(true);
    setError(null);
    try {
      // Signing in on a station replaces whoever was signed in before.
      await apiFetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
      const response = await apiFetch('/api/auth/lab/sign-in', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      const failure = await labSignInError(response);
      if (failure) {
        setError(failure);
        setPassword('');
        return;
      }
      await onSignedIn();
    } catch {
      setError({
        kind: 'other',
        message: 'Material Mule couldn’t be reached. Check the connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  const wrong = error?.kind === 'wrong';
  return (
    <section className="flex flex-col gap-6" aria-labelledby={headingId}>
      <div className="grid gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Shared receiving station
        </h2>
        <p className="text-sm text-muted-foreground">{isStation ? LAB_STATION_HINT : LAB_HINT}</p>
      </div>
      {error?.kind === 'paused' ? (
        <Alert className="border-stage-due-mark/50 [&>svg]:text-stage-due-fg">
          <Pause aria-hidden="true" />
          <AlertTitle className="line-clamp-none">{error.message}</AlertTitle>
          <AlertDescription className="text-stage-due-fg">{PAUSED_HELP}</AlertDescription>
        </Alert>
      ) : null}
      {error?.kind === 'other' ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)} noValidate>
        <FieldGroup className="gap-5">
          <Field className="gap-2">
            <FieldLabel htmlFor={userId}>Username</FieldLabel>
            <Input
              id={userId}
              className="font-mono"
              name="username"
              autoComplete="username"
              autoCapitalize="characters"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </Field>
          <Field className="gap-2" data-invalid={wrong || undefined}>
            <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
            <Input
              id={passwordId}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={wrong || undefined}
              aria-describedby={wrong ? passwordErrorId : undefined}
              required
            />
            {wrong ? (
              <FieldError id={passwordErrorId} className="flex items-center gap-2">
                <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                {error.message}
              </FieldError>
            ) : null}
          </Field>
        </FieldGroup>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || !password || !!retryAfterMs}
        >
          {busy ? 'Signing in…' : 'Sign in as LAB'}
        </Button>
        <p className="text-sm text-muted-foreground">Forgot password? Ask an administrator.</p>
      </form>
    </section>
  );
}
