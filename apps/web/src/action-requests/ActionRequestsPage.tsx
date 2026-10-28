import {
  ACTION_REQUEST_RESOLUTION_LABEL,
  type ActionRequest,
  type PersonSnapshot,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useMe } from '../session/context';
import {
  announceActionRequestsChanged,
  fetchActionRequests,
  fetchAssignees,
  reassign,
} from './api';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: ActionRequest[] };

function who(person: PersonSnapshot): string {
  return person.initials ?? person.name;
}

/**
 * Action requests (MM-T27): requests waiting on the signed-in person, with who asked and why and a
 * link to where the decision is made. Opening the link and taking the real action (close, cancel,
 * mark correction done) is what resolves an item; nothing here approves anything.
 */
export function ActionRequestsPage() {
  const me = useMe();
  const canReassign = me.permissions.includes('action_item.reassign');
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    fetchActionRequests(status, scope)
      .then((list) => {
        if (active) setLoad({ state: 'ready', items: list.items });
      })
      .catch(() => {
        if (active) setLoad({ state: 'error' });
      });
    return () => {
      active = false;
    };
  }, [status, scope, tick]);

  return (
    <div className="action-requests-page">
      <PageHeader title="Action requests" />
      <p className="field-hint">
        Requests that need your decision. Ordinary activity (moves, receipts, comments and test
        progress) stays in each record’s history and never appears here.
      </p>
      <div className="action-requests-filters" role="group" aria-label="Show">
        {(['open', 'resolved'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            className={status === value ? 'primary' : undefined}
            onClick={() => {
              setLoad({ state: 'loading' });
              setStatus(value);
            }}
          >
            {value === 'open' ? 'Open' : 'Resolved'}
          </button>
        ))}
        {canReassign ? (
          <label className="action-requests-scope">
            <input
              type="checkbox"
              checked={scope === 'all'}
              onChange={(event) => {
                setLoad({ state: 'loading' });
                setScope(event.target.checked ? 'all' : 'mine');
              }}
            />{' '}
            Everyone’s requests (to reassign)
          </label>
        ) : null}
      </div>
      {load.state === 'loading' ? <p>Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message="Action requests couldn’t load." onRetry={reload} />
      ) : null}
      {load.state === 'ready' && load.items.length === 0 ? (
        <EmptyState>
          {status === 'open' ? 'Nothing is waiting on you.' : 'No resolved requests yet.'}
        </EmptyState>
      ) : null}
      {load.state === 'ready' && load.items.length > 0 ? (
        <ul className="action-request-list">
          {load.items.map((item) => (
            <ActionRequestRow key={item.id} item={item} onChanged={reload} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ActionRequestRow({ item, onChanged }: { item: ActionRequest; onChanged: () => void }) {
  const [reassigning, setReassigning] = useState(false);
  return (
    <li className="action-request" aria-label={item.title}>
      <div className="action-request-main">
        <p className="action-request-title">
          <strong>{item.routeTag}:</strong> {item.title} by {who(item.requestedBy)}
          {item.reason ? <> · {item.reason}</> : null}
        </p>
        <p className="action-request-meta">
          {item.projectNumber} · {item.routedTo} · requested {formatExpiry(item.createdAt)}
          {item.status === 'resolved' && item.resolvedBy ? (
            <>
              {' · '}
              <StatusBadge tone="success">
                Resolved by {who(item.resolvedBy)}
                {item.resolution ? ` · ${ACTION_REQUEST_RESOLUTION_LABEL[item.resolution]}` : ''}
              </StatusBadge>
            </>
          ) : null}
        </p>
      </div>
      <div className="action-request-actions">
        <Link className="button" to={item.href}>
          Open
        </Link>
        {item.canReassign && !reassigning ? (
          <button type="button" onClick={() => setReassigning(true)}>
            Reassign
          </button>
        ) : null}
      </div>
      {reassigning ? (
        <ReassignForm
          item={item}
          onCancel={() => setReassigning(false)}
          onDone={() => {
            setReassigning(false);
            announceActionRequestsChanged();
            onChanged();
          }}
        />
      ) : null}
    </li>
  );
}

function ReassignForm({
  item,
  onCancel,
  onDone,
}: {
  item: ActionRequest;
  onCancel: () => void;
  onDone: () => void;
}) {
  const personId = useId();
  const reasonId = useId();
  const [people, setPeople] = useState<PersonSnapshot[] | null>(null);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  useEffect(() => {
    fetchAssignees(item.id)
      .then(setPeople)
      .catch(() => setError('The people who can act on this couldn’t load.'));
  }, [item.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await reassign(item.id, to, reason, key);
    setBusy(false);
    if (outcome.ok) onDone();
    else setError(outcome.message);
  }

  return (
    <form
      className="action-request-reassign"
      aria-label="Reassign"
      onSubmit={(e) => void submit(e)}
    >
      <label htmlFor={personId}>Reassign to</label>
      <select id={personId} value={to} onChange={(event) => setTo(event.target.value)} required>
        <option value="">Choose a person</option>
        {(people ?? []).map((person) => (
          <option key={person.userId} value={person.userId}>
            {person.name}
            {person.initials ? ` (${person.initials})` : ''}
          </option>
        ))}
      </select>
      <label htmlFor={reasonId}>Reason (required)</label>
      <textarea
        id={reasonId}
        value={reason}
        maxLength={2000}
        onChange={(event) => setReason(event.target.value)}
        required
      />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !to || !reason.trim()}>
          Reassign
        </button>
      </div>
    </form>
  );
}
