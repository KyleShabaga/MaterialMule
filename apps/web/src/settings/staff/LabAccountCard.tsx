import {
  LAB_PASSWORD_MIN_LENGTH,
  labAccountResponseSchema,
  labPasswordResetRequestSchema,
  type LabAccountResponse,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../../api/client';
import { BandedCard, ConfirmDialog, ErrorState, FormField } from '../../components/ui';
import { formatExpiry } from '../../lib/format';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'forbidden' }
  | { state: 'ready'; account: LabAccountResponse };

async function loadAccount(): Promise<Load> {
  const response = await apiFetch('/api/admin/lab').catch(() => null);
  if (response?.status === 403) return { state: 'forbidden' };
  const parsed = response?.ok ? labAccountResponseSchema.safeParse(await response.json()) : null;
  return parsed?.success ? { state: 'ready', account: parsed.data } : { state: 'error' };
}

type Pending = { kind: 'reset'; password: string } | { kind: 'revoke' } | null;

/**
 * The shared receiving account: reset its password or sign out every LAB station. A 403 means the
 * viewer lost Admin; `onForbidden` lets Staff & access replace the whole page (MM-T52).
 */
export function LabAccountCard({ onForbidden }: { onForbidden?: () => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => setLoad(await loadAccount()), []);

  useEffect(() => {
    if (load.state === 'forbidden') onForbidden?.();
  }, [load.state, onForbidden]);

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
    let response: Response;
    try {
      response =
        action.kind === 'reset'
          ? await apiFetch('/api/admin/lab/password', {
              method: 'POST',
              body: JSON.stringify({ newPassword: action.password }),
            })
          : await apiFetch(`/api/admin/users/${load.account.userId}/sessions/revoke`, {
              method: 'POST',
            });
    } catch {
      // The request may or may not have arrived, so don't promise that nothing changed.
      setActionError(
        'Material Mule couldn’t be reached. Check the connection, then reload to see whether it worked.',
      );
      return;
    }
    if (response.status === 403) {
      onForbidden?.();
      return;
    }
    if (response.status >= 500) {
      // A gateway or server error may come after the change was made: say so (MM-T61).
      setActionError(
        'Material Mule had a problem, so it isn’t clear whether this worked. Reload the page to check before trying again.',
      );
      return;
    }
    if (!response.ok) {
      setActionError('That didn’t work. Nothing was changed. Try again.');
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
    <BandedCard
      className="lab-account"
      title="Shared receiving account (LAB)"
      subtitle="LAB is managed in Material Mule, not a Microsoft account. It can receive, search and print labels only."
    >
      {load.state === 'loading' || load.state === 'forbidden' ? <p>Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message="The LAB account couldn't load." onRetry={() => void reload()} />
      ) : null}
      {load.state === 'ready' ? (
        <>
          <dl className="stat-tiles">
            <div className={load.account.passwordSet ? undefined : 'stat-tile-warning'}>
              <dt>Password</dt>
              <dd>
                {load.account.passwordSet
                  ? `Set${load.account.passwordUpdatedAt ? ` ${formatExpiry(load.account.passwordUpdatedAt)}` : ''}`
                  : 'Not set — LAB can’t sign in yet'}
              </dd>
            </div>
            <div>
              <dt>Signed-in stations</dt>
              <dd className="stat-number">{load.account.activeSessions}</dd>
            </div>
            {load.account.lockedUntil ? (
              <div className="stat-tile-warning">
                <dt>Locked after failed sign-ins until</dt>
                <dd>{formatExpiry(load.account.lockedUntil)}</dd>
              </div>
            ) : null}
          </dl>
          {notice ? <p role="status">{notice}</p> : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          <form className="lab-password-form" onSubmit={requestReset} noValidate>
            <div className="field-pair">
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
            </div>
            <div className="lab-actions">
              <button
                type="button"
                className="danger"
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
    </BandedCard>
  );
}
