import {
  formatPerson,
  type AcceptanceDelegates,
  type AcceptanceDelegation,
  type ReceiverOption,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { BandedCard, ConfirmDialog, EmptyState, ErrorState } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { fetchDelegates, grantDelegate, revokeDelegate, type WriteResult } from '../lab/api';

// "Acceptance delegates" on the project page (MM-T25, owner decision 2026-10-25). Only the
// project's Lead Project Engineer adds and revokes delegates (the server checks); everyone with a personal
// account sees who may accept. A delegate may accept tests on this project only, never close a
// program or change priority. Revoking blocks new acceptances at once; earlier acceptances keep
// their attribution, and every grant stays in the history. Adding and revoking each need a reason
// (D15, MM-AO03), shown in the history.

function problemText(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  if (result.kind === 'invalid') {
    return result.errors.map((error) => error.message).join(' ') || 'Check the details.';
  }
  if (result.kind === 'forbidden')
    return 'Only the project’s Lead Project Engineer manages acceptance delegates.';
  if (result.kind === 'network') return 'Couldn’t reach Material Mule. Try again.';
  return 'Something went wrong. Try again.';
}

export function AcceptanceDelegatesSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<AcceptanceDelegates | null>(null);
  const [failed, setFailed] = useState(false);
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning'; text: string } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [revoking, setRevoking] = useState<AcceptanceDelegation | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const reasonId = useId();
  const revokeReasonId = useId();

  const load = useCallback(() => {
    fetchDelegates(projectId).then(
      (loaded) => {
        setData(loaded);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [projectId]);
  useEffect(load, [load]);

  const after = (result: WriteResult<AcceptanceDelegates>, success: string) => {
    if (result.ok) {
      setData(result.value);
      setMessage({ tone: 'success', text: success });
    } else {
      setMessage({ tone: 'warning', text: problemText(result) });
      load();
    }
  };

  return (
    <BandedCard className="project-section" title="Acceptance delegates">
      {failed ? <ErrorState message="Delegates couldn’t be loaded." onRetry={load} /> : null}
      {message ? (
        <p className={`notice notice-${message.tone}`} role="status">
          {message.text}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="field-hint">
            Delegates may accept reviewed tests on this project. They can’t close programs or change
            priority.
          </p>
          {data.active.length === 0 ? (
            <EmptyState>No acceptance delegates.</EmptyState>
          ) : (
            <ul className="delegate-list" aria-label="Acceptance delegates">
              {data.active.map((grant) => (
                <li key={grant.id}>
                  <strong>{formatPerson(grant.delegate.initials, grant.delegate.name)}</strong>
                  <span className="field-hint">
                    Added by {formatPerson(grant.grantedBy.initials, grant.grantedBy.name)},{' '}
                    {shortDateTime(grant.grantedAt)}
                  </span>
                  {grant.grantReason ? (
                    <span className="field-hint">Reason: {grant.grantReason}</span>
                  ) : null}
                  {data.canManage ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRevoking(grant);
                        setRevokeReason('');
                        setRevokeError(null);
                      }}
                    >
                      Revoke {grant.delegate.name}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {data.canManage ? (
            <form
              className="delegate-add"
              aria-label="Add acceptance delegate"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!person || !reason.trim()) return;
                setBusy(true);
                const result = await grantDelegate(projectId, {
                  delegateUserId: person.id,
                  reason,
                  idempotencyKey: key,
                });
                setBusy(false);
                if (result.ok || result.kind !== 'network') setKey(crypto.randomUUID());
                if (result.ok) {
                  setPerson(null);
                  setReason('');
                }
                after(result, `Added ${person.displayName} as an acceptance delegate.`);
              }}
            >
              <ReceiverSelect
                label="Add a delegate"
                value={person}
                onChange={setPerson}
                hint="Search by initials or name."
              />
              <div className="form-field">
                <label htmlFor={reasonId}>Reason</label>
                <textarea
                  id={reasonId}
                  value={reason}
                  maxLength={2000}
                  rows={2}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <button type="submit" disabled={busy || !person || !reason.trim()}>
                Add delegate
              </button>
            </form>
          ) : null}
          {data.history.length > 0 ? (
            <details className="delegate-history">
              <summary>Delegation history ({data.history.length})</summary>
              <ul className="delegate-list">
                {data.history.map((grant) => (
                  <li key={grant.id}>
                    {formatPerson(grant.delegate.initials, grant.delegate.name)}: added by{' '}
                    {formatPerson(grant.grantedBy.initials, grant.grantedBy.name)},{' '}
                    {shortDateTime(grant.grantedAt)}; revoked by{' '}
                    {grant.revokedBy
                      ? formatPerson(grant.revokedBy.initials, grant.revokedBy.name)
                      : ''}
                    , {grant.revokedAt ? shortDateTime(grant.revokedAt) : ''}
                    {grant.revokeReason ? ` (${grant.revokeReason})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : failed ? null : (
        <p role="status">Loading…</p>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.delegate.name ?? ''}?`}
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          if (!revoking) return;
          if (!revokeReason.trim()) {
            setRevokeError('Enter a reason.');
            return;
          }
          const grant = revoking;
          setRevoking(null);
          setBusy(true);
          const result = await revokeDelegate(projectId, grant.id, revokeReason);
          setBusy(false);
          after(result, `Revoked ${grant.delegate.name}.`);
        }}
        onCancel={() => setRevoking(null)}
      >
        <p>They can no longer accept tests on this project. Earlier acceptances keep their name.</p>
        <label htmlFor={revokeReasonId}>Reason</label>
        <textarea
          id={revokeReasonId}
          value={revokeReason}
          maxLength={2000}
          aria-invalid={Boolean(revokeError)}
          onChange={(event) => setRevokeReason(event.target.value)}
        />
        {revokeError ? <p className="field-error">{revokeError}</p> : null}
      </ConfirmDialog>
    </BandedCard>
  );
}
