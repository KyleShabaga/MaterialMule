import {
  LAB_PASSWORD_MIN_LENGTH,
  labAccountResponseSchema,
  labPasswordResetRequestSchema,
  type LabAccountResponse,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { apiFetch } from '../../api/client';
import { formatExpiry } from '../../lib/format';
import { ConfirmReasonDialog, ErrorAlert, SectionTitle, TOUCH } from './staff-ui';

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

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div
      className={cn('rounded-lg border p-3', warn && 'border-stage-due-mark/50 bg-stage-due-bg')}
    >
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn('mt-1 text-sm', warn && 'text-stage-due-fg')}>{value}</dd>
    </div>
  );
}

/**
 * The shared receiving account: reset its password or sign out every LAB station. A 403 means the
 * viewer lost the permission; `onForbidden` lets the Staff page replace itself (MM-T52).
 */
export function LabAccountCard({ onForbidden }: { onForbidden?: () => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const headingId = useId();
  const passwordId = useId();
  const repeatId = useId();

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
    <section aria-labelledby={headingId} className="grid max-w-3xl gap-3">
      <div className="grid gap-1">
        <SectionTitle as="h2" id={headingId}>
          Shared receiving account (LAB)
        </SectionTitle>
        <p className="text-sm text-muted-foreground">
          LAB is managed in Material Mule, not a Microsoft account. It can receive, search and print
          labels only.
        </p>
      </div>
      {load.state === 'loading' || load.state === 'forbidden' ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : null}
      {load.state === 'error' ? (
        <ErrorAlert title="The LAB account couldn't load." onRetry={() => void reload()} />
      ) : null}
      {load.state === 'ready' ? (
        <>
          <dl className="grid gap-2 sm:grid-cols-3">
            <Stat
              label="Password"
              warn={!load.account.passwordSet}
              value={
                load.account.passwordSet
                  ? `Set${load.account.passwordUpdatedAt ? ` ${formatExpiry(load.account.passwordUpdatedAt)}` : ''}`
                  : 'Not set — LAB can’t sign in yet'
              }
            />
            <Stat label="Signed-in stations" value={String(load.account.activeSessions)} />
            {load.account.lockedUntil ? (
              <Stat
                label="Locked after failed sign-ins until"
                value={formatExpiry(load.account.lockedUntil)}
                warn
              />
            ) : null}
          </dl>
          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          {actionError ? <ErrorAlert title={actionError} /> : null}
          <form className="grid gap-3" onSubmit={requestReset} noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={passwordId}>New LAB password</FieldLabel>
                <Input
                  id={passwordId}
                  type="password"
                  autoComplete="new-password"
                  className={TOUCH}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <FieldDescription>At least {LAB_PASSWORD_MIN_LENGTH} characters.</FieldDescription>
              </Field>
              <Field data-invalid={fieldError ? true : undefined}>
                <FieldLabel htmlFor={repeatId}>Repeat the new password</FieldLabel>
                <Input
                  id={repeatId}
                  type="password"
                  autoComplete="new-password"
                  className={TOUCH}
                  aria-invalid={fieldError ? true : undefined}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                {fieldError ? <FieldError>{fieldError}</FieldError> : null}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" className={TOUCH}>
                Reset LAB password
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn('text-destructive-text', TOUCH)}
                disabled={load.account.activeSessions === 0}
                onClick={() => {
                  setNotice(null);
                  setPending({ kind: 'revoke' });
                }}
              >
                Sign out all LAB stations
              </Button>
            </div>
          </form>
        </>
      ) : null}
      <ConfirmReasonDialog
        open={pending !== null}
        title={pending?.kind === 'revoke' ? 'Sign out all LAB stations?' : 'Reset LAB password?'}
        confirmLabel={pending?.kind === 'revoke' ? 'Sign out LAB' : 'Reset password'}
        destructive={pending?.kind === 'revoke'}
        description={`Every station signed in as LAB will be signed out on its next action${
          pending?.kind === 'reset' ? ' and will need the new password' : ''
        }. Unconfirmed drafts stay on each station.`}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
