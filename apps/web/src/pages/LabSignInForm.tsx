import { LAB_USERNAME, signInLockedResponseSchema } from '@materialmule/shared';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api/client';
import { FormField } from '../components/ui';

/** Messages for each sign-in failure. None repeats what was typed. */
async function labSignInError(response: Response): Promise<string | null> {
  if (response.ok) return null;
  if (response.status === 401) return 'The username or password is incorrect.';
  if (response.status === 429) {
    const body = signInLockedResponseSchema.safeParse(await response.json().catch(() => null));
    const minutes = body.success ? Math.max(1, Math.ceil(body.data.retryAfterSeconds / 60)) : 15;
    return `Too many failed attempts. Sign-in is paused for about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  if (response.status === 400) return 'Enter the username and password.';
  return `Sign-in failed (HTTP ${response.status}). Try again.`;
}

/**
 * Shared receiving station sign-in (MM-T06). LAB is an app-managed account, not a Microsoft
 * account; its password is set by an administrator.
 */
export function LabSignInForm({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState(LAB_USERNAME);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
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
      const message = await labSignInError(response);
      if (message) {
        setError(message);
        setPassword('');
        return;
      }
      await onSignedIn();
    } catch {
      setError('The server could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="lab-sign-in">
      <h2 id="lab-sign-in">Shared receiving station (LAB)</h2>
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
        <FormField label="Password" error={error}>
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
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in as LAB'}
        </button>
      </form>
      <p className="field-hint">Forgot password? Ask an administrator.</p>
    </section>
  );
}
