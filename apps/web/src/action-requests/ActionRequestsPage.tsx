import {
  ACTION_REQUEST_RESOLUTION_LABEL,
  type ActionRequest,
  type ActionRequestKind,
  type ActionRequestScope,
  type PersonSnapshot,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Segmented,
  StatusBadge,
  type BadgeTone,
} from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useMe } from '../session/context';
import {
  announceActionRequestsChanged,
  fetchActionRequests,
  fetchAssignees,
  reassign,
} from './api';
import './action-requests.css';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: ActionRequest[] };

function who(person: PersonSnapshot): string {
  return person.initials ?? person.name;
}

/**
 * Field Ledger: each request's kind as a tag, and the one action that opens the real record
 * (named for where it goes). Closing happens there, never here.
 */
const KIND: Record<ActionRequestKind, { tag: string; tone: BadgeTone; action: string }> = {
  correction: { tag: 'Correction', tone: 'waiting', action: 'Open the program' },
  cancellation_request: { tag: 'Cancel a test', tone: 'danger', action: 'Open the program' },
  closure_request: { tag: 'Close a program', tone: 'lab', action: 'Open the program' },
  retention_request: { tag: 'Retention', tone: 'waiting', action: 'Open retention' },
  lead_appointment: { tag: 'Lead appointment', tone: 'closed', action: 'Open the project' },
  grant_review: { tag: 'Grant review', tone: 'closed', action: 'Open the team' },
  team_join_request: { tag: 'Team join', tone: 'closed', action: 'Open the team' },
  review_approval_lost: { tag: 'Reviewer lost', tone: 'waiting', action: 'Open the team' },
};

/**
 * Action requests (MM-T27): requests waiting on the signed-in person, with who asked and why and a
 * link to where the decision is made. Opening the link and taking the real action (close, cancel,
 * mark correction done) is what resolves an item; nothing here approves anything.
 */
export function ActionRequestsPage() {
  const me = useMe();
  // MTR-2: the shared LAB account has no inbox, so don't ask the server for one.
  if (!me.permissions.includes('action_item.read')) {
    return (
      <div className="action-requests-page">
        <PageHeader title="Action requests" />
        <EmptyState>
          Action requests are for personal accounts. Sign in with your own account.
        </EmptyState>
      </div>
    );
  }
  return <ActionRequestsInbox />;
}

function ActionRequestsInbox() {
  const me = useMe();
  const canReassign = me.permissions.includes('action_item.reassign');
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [scope, setScope] = useState<ActionRequestScope>('mine');
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
      <div className="action-requests-title">
        <PageHeader title="Action requests" />
        <span className="section-meta">Work someone has asked you to do</span>
      </div>
      <div className="action-requests-closes">
        <span className="field-label">How it closes</span>
        <p>
          A request closes when someone does the real thing on the record it points to. There is no
          approve button here. Ordinary activity (moves, receipts, comments and test progress) stays
          in each record’s history and never appears here.
        </p>
      </div>
      <div className="action-requests-filters">
        <Segmented
          label="Show"
          options={[
            { value: 'open', label: 'Open' },
            { value: 'resolved', label: 'Resolved' },
          ]}
          value={status}
          onChange={(value) => {
            if (value === status) return;
            setLoad({ state: 'loading' });
            setStatus(value);
          }}
        />
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
        {canReassign && status === 'open' ? (
          <label className="action-requests-scope">
            <input
              type="checkbox"
              checked={scope === 'unresolved'}
              onChange={(event) => {
                setLoad({ state: 'loading' });
                setScope(event.target.checked ? 'unresolved' : 'mine');
              }}
            />{' '}
            Unresolved: nobody can act on them now
          </label>
        ) : null}
      </div>
      {load.state === 'loading' ? <p>Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message="Action requests couldn’t load." onRetry={reload} />
      ) : null}
      {load.state === 'ready' && load.items.length === 0 ? (
        <EmptyState>
          {scope === 'unresolved'
            ? 'Every open request has someone who can act on it.'
            : status === 'open'
              ? 'Nothing is waiting on you.'
              : 'No resolved requests yet.'}
        </EmptyState>
      ) : null}
      {load.state === 'ready' && load.items.length > 0 ? (
        <ul className="action-request-list">
          {load.items.map((item) => (
            <ActionRequestRow key={item.id} item={item} onChanged={reload} />
          ))}
        </ul>
      ) : null}
      <p className="field-hint">
        Reassigning needs a reason and can only go to someone who can act on that kind of request.
        The shared LAB station has no action requests.
      </p>
    </div>
  );
}

function ActionRequestRow({ item, onChanged }: { item: ActionRequest; onChanged: () => void }) {
  const [reassigning, setReassigning] = useState(false);
  const kind = KIND[item.kind];
  return (
    <li
      className={item.status === 'resolved' ? 'action-request is-resolved' : 'action-request'}
      aria-label={item.title}
      data-row
    >
      <span className="action-request-kind">
        <StatusBadge tone={kind.tone}>{kind.tag}</StatusBadge>
      </span>
      <div className="action-request-main">
        <p className="action-request-title">
          <strong>{item.routeTag}:</strong> {item.title} by {who(item.requestedBy)}
          {item.reason ? <> · {item.reason}</> : null}
        </p>
        <p className="action-request-meta">
          <span className="mono">{item.projectNumber}</span> · {item.routedTo}
          {item.unresolved ? (
            <>
              {' · '}
              <StatusBadge tone="danger">Nobody can act on this now</StatusBadge>
            </>
          ) : item.assignmentLapsed ? (
            <>
              {' · '}
              <StatusBadge tone="warning">Assignment lapsed</StatusBadge>
            </>
          ) : null}
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
      <div className="action-request-who">
        <span className="field-label">Asked by</span>
        <span>
          {item.requestedBy.name} · {formatExpiry(item.createdAt)}
        </span>
      </div>
      <div className="action-request-actions">
        <Link className={item.status === 'open' ? 'button primary' : 'button'} to={item.href}>
          {kind.action}
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
