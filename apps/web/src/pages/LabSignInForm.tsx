import { LAB_USERNAME, signInLockedResponseSchema } from '@materialmule/shared';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api/client';
import { FormField, StatusBadge } from '../components/ui';

interface SignInFailure {
  message: string;
  /** Too many failed attempts: sign-in is paused (shown as the amber "Paused" state). */
  paused: boolean;
}

/** Messages for each sign-in failure. None repeats what was typed. */
async function labSignInError(response: Response): Promise<SignInFailure | null> {
  if (response.ok) return null;
  const failure = (message: string) => ({ message, paused: false });
  if (response.status === 401) return failure('The username or password is incorrect.');
  if (response.status === 429) {
    const body = signInLockedResponseSchema.safeParse(await response.json().catch(() => null));
    const minutes = body.success ? Math.max(1, Math.ceil(body.data.retryAfterSeconds / 60)) : 15;
    return {
      message: `Too many failed attempts. Sign-in is paused for about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      paused: true,
    };
  }
  if (response.status === 400) return failure('Enter the username and password.');
  return failure('Sign-in didn’t work. Try again.');
}

/**
 * Shared receiving station sign-in (MM-T06). LAB is an app-managed account, not a Microsoft
 * account; its password is set by an administrator.
 */
export function LabSignInForm({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState(LAB_USERNAME);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInFailure | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
      setError({ message: 'The server could not be reached. Try again.', paused: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card lab-sign-in" aria-labelledby="lab-sign-in">
      <div className="auth-card-head">
        <div>
          <h2 id="lab-sign-in">Shared receiving station (LAB)</h2>
          <p className="field-hint">For the receiving PC that several people share.</p>
        </div>
        {error?.paused ? <StatusBadge tone="warning">Paused</StatusBadge> : null}
      </div>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Username">
          {(props) => (
            <input
              {...props}
              name="username"
              autoComplete="username"
              autoCapitalize="characters"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          )}
        </FormField>
        <FormField label="Password" error={error && !error.paused ? error.message : null}>
          {(props) => (
            <input
              {...props}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          )}
        </FormField>
        {error?.paused ? (
          <div className="notice notice-warning" role="alert">
            <p>{error.message}</p>
            <p>An administrator can reset the LAB password to end the pause sooner.</p>
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in as LAB'}
        </button>
      </form>
      <p className="field-hint">Forgot password? Ask an administrator.</p>
    </section>
  );
}
