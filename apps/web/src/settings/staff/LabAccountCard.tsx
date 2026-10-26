import {
  LAB_PASSWORD_MIN_LENGTH,
  labAccountResponseSchema,
  labPasswordResetRequestSchema,
  type LabAccountResponse,
} from '@trapezoid/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../api/client';
import { ConfirmDialog, ErrorState, FormField } from '../../components/ui';
import { formatExpiry } from '../../lib/format';

type Load =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; account: LabAccountResponse };

async function loadAccount(): Promise<Load> {
  const response = await apiFetch('/api/admin/lab').catch(() => null);
  const parsed = response?.ok ? labAccountResponseSchema.safeParse(await response.json()) : null;
  return parsed?.success ? { state: 'ready', account: parsed.data } : { state: 'error' };
}

type Pending = { kind: 'reset'; password: string } | { kind: 'revoke' } | null;

/** The shared receiving account: reset its password or sign out every LAB station. */
export function LabAccountCard() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => setLoad(await loadAccount()), []);

  useEffect(() => {
    let active = true;
    void loadAccount().then((next) => {
      if (active) setLoad(next);
    });
    return () => {
      active = false;
    };
  }, []);

  function requestReset(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const parsed = labPasswordResetRequestSchema.safeParse({ newPassword: password });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'The password is not acceptable.');
      return;
    }
    if (password !== confirmation) {
      setFieldError('The two passwords don’t match.');
      return;
    }
    setFieldError(null);
    setPending({ kind: 'reset', password });
  }

  async function confirm() {
    if (!pending || load.state !== 'ready') return;
    const action = pending;
    setPending(null);
    setActionError(null);
    const response =
      action.kind === 'reset'
        ? await apiFetch('/api/admin/lab/password', {
            method: 'POST',
            body: JSON.stringify({ newPassword: action.password }),
          })
        : await apiFetch(`/api/admin/users/${load.account.userId}/sessions/revoke`, {
            method: 'POST',
          });
    if (!response.ok) {
      setActionError(`That didn’t work (HTTP ${response.status}). Nothing was changed.`);
      return;
    }
    if (action.kind === 'reset') {
      setPassword('');
      setConfirmation('');
      setNotice('LAB password reset. Every LAB station has been signed out.');
    } else {
      setNotice('Every LAB station has been signed out.');
    }
    await reload();
  }

  return (
    <section className="card" aria-labelledby="lab-account">
      <h2 id="lab-account">Shared receiving account (LAB)</h2>
      <p className="field-hint">
        LAB is managed in Trapezoid, not a Microsoft account. It can receive, search and print
        labels only.
      </p>
      {load.state === 'loading' ? <p>Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message="The LAB account couldn't load." onRetry={() => void reload()} />
      ) : null}
      {load.state === 'ready' ? (
        <>
          <dl className="status">
            <dt>Password</dt>
            <dd>
              {load.account.passwordSet
                ? `Set${load.account.passwordUpdatedAt ? ` ${formatExpiry(load.account.passwordUpdatedAt)}` : ''}`
                : 'Not set — LAB can’t sign in yet'}
            </dd>
            <dt>Signed-in stations</dt>
            <dd>{load.account.activeSessions}</dd>
            {load.account.lockedUntil ? (
              <>
                <dt>Locked after failed sign-ins until</dt>
                <dd>{formatExpiry(load.account.lockedUntil)}</dd>
              </>
            ) : null}
          </dl>
          {notice ? <p role="status">{notice}</p> : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          <form onSubmit={requestReset} noValidate>
            <FormField
              label="New LAB password"
              hint={`At least ${LAB_PASSWORD_MIN_LENGTH} characters.`}
            >
              {(props) => (
                <input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="Repeat the new password" error={fieldError}>
              {(props) => (
                <input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              )}
            </FormField>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={load.account.activeSessions === 0}
                onClick={() => {
                  setNotice(null);
                  setPending({ kind: 'revoke' });
                }}
              >
                Sign out all LAB stations
              </button>
              <button type="submit" className="primary">
                Reset LAB password
              </button>
            </div>
          </form>
        </>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'revoke' ? 'Sign out all LAB stations?' : 'Reset LAB password?'}
        confirmLabel={pending?.kind === 'revoke' ? 'Sign out LAB' : 'Reset password'}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      >
        <p>
          Every station signed in as LAB will be signed out on its next action
          {pending?.kind === 'reset' ? ' and will need the new password' : ''}. Unconfirmed drafts
          stay on each station.
        </p>
      </ConfirmDialog>
    </section>
  );
}
