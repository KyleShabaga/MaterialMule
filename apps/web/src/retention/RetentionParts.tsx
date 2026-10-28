import type { RetentionExtension, RetentionHold } from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { postRetention } from './api';

// Shared MM-T29 pieces: the hold/extension form (decide directly, or request for people without
// authority) and the history list with Release. Every rule is checked again by the server.

function who(person: { initials: string | null; name: string }) {
  return person.initials ? `${person.initials} · ${person.name}` : person.name;
}

export function RetentionForm({
  projectId,
  unitIds,
  mode,
  onDone,
}: {
  projectId: string;
  /** Selected units; omitted for the whole project. */
  unitIds?: string[];
  mode: 'manage' | 'request';
  onDone: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<'hold' | 'extension'>('hold');
  const [amount, setAmount] = useState<'date' | 'months'>('date');
  const [retainUntil, setRetainUntil] = useState('');
  const [months, setMonths] = useState('12');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const scope = unitIds ? { scope: 'units', unitIds } : { scope: 'project' };
    const extension =
      kind === 'extension'
        ? amount === 'date'
          ? { retainUntil }
          : { extendMonths: Number(months) }
        : {};
    const outcome =
      mode === 'request'
        ? await postRetention('/api/retention/requests', {
            kind,
            projectId,
            ...scope,
            ...extension,
            reason,
            idempotencyKey: key,
          })
        : await postRetention(
            kind === 'hold' ? '/api/retention/holds' : '/api/retention/extensions',
            {
              projectId,
              ...scope,
              ...extension,
              reason,
              idempotencyKey: key,
            },
          );
    setBusy(false);
    if (outcome.ok) {
      setReason('');
      setKey(crypto.randomUUID());
      onDone();
    } else {
      setError(outcome.message);
    }
  }

  const target = unitIds ? 'this unit' : 'the whole project (current and future units)';
  return (
    <form
      className="retention-form"
      aria-label={mode === 'request' ? 'Request a hold or extension' : 'Place a hold or extension'}
      onSubmit={(event) => void submit(event)}
    >
      <fieldset>
        <legend>{mode === 'request' ? 'Ask for' : 'Add'}</legend>
        <label>
          <input type="radio" checked={kind === 'hold'} onChange={() => setKind('hold')} /> Hold on{' '}
          {target}
        </label>
        <label>
          <input
            type="radio"
            checked={kind === 'extension'}
            onChange={() => setKind('extension')}
          />{' '}
          Extension for {target}
        </label>
      </fieldset>
      {kind === 'extension' ? (
        <div className="retention-amount">
          <label>
            <input type="radio" checked={amount === 'date'} onChange={() => setAmount('date')} />{' '}
            Retain until
          </label>
          <input
            type="date"
            aria-label="New retain-until date"
            value={retainUntil}
            disabled={amount !== 'date'}
            onChange={(event) => setRetainUntil(event.target.value)}
          />
          <label>
            <input
              type="radio"
              checked={amount === 'months'}
              onChange={() => setAmount('months')}
            />{' '}
            Add months to the minimum
          </label>
          <input
            type="number"
            min={1}
            max={600}
            aria-label="Months to add"
            value={months}
            disabled={amount !== 'months'}
            onChange={(event) => setMonths(event.target.value)}
          />
        </div>
      ) : null}
      <label htmlFor={`${id}-reason`}>Reason (required)</label>
      <textarea
        id={`${id}-reason`}
        value={reason}
        maxLength={2000}
        onChange={(event) => setReason(event.target.value)}
      />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy || !reason.trim()}>
        {mode === 'request' ? 'Send request' : kind === 'hold' ? 'Place hold' : 'Set extension'}
      </button>
      {mode === 'request' ? (
        <p className="field-hint">
          The project’s PM/PE and the Lab Managers decide; nothing changes until one of them does.
        </p>
      ) : null}
    </form>
  );
}

export function RetentionHistory({
  holds,
  extensions,
  canManage,
  onChanged,
}: {
  holds: RetentionHold[];
  extensions: RetentionExtension[];
  canManage: boolean;
  onChanged: () => void;
}) {
  if (holds.length === 0 && extensions.length === 0) {
    return <p className="field-hint">No holds or extensions.</p>;
  }
  return (
    <ul className="retention-history">
      {holds.map((item) => (
        <DecisionRow
          key={item.id}
          kind="holds"
          item={item}
          title={`Hold: ${item.reason}`}
          by={`Placed by ${who(item.placedBy)} · ${formatExpiry(item.placedAt)}`}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
      {extensions.map((item) => (
        <DecisionRow
          key={item.id}
          kind="extensions"
          item={item}
          title={`Extension ${item.retainUntil ? `to ${item.retainUntil}` : `+${item.extendMonths} months`}: ${item.reason}`}
          by={`Set by ${who(item.setBy)} · ${formatExpiry(item.setAt)}`}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function DecisionRow({
  kind,
  item,
  title,
  by,
  canManage,
  onChanged,
}: {
  kind: 'holds' | 'extensions';
  item: RetentionHold | RetentionExtension;
  title: string;
  by: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const scope =
    item.scope === 'project'
      ? 'Whole project'
      : item.units.map((unit) => unit.readableId).join(', ');

  async function release(event: FormEvent) {
    event.preventDefault();
    const outcome = await postRetention(`/api/retention/${kind}/${item.id}/release`, {
      reason,
      version: item.version,
      idempotencyKey: key,
    });
    if (outcome.ok) onChanged();
    else {
      setError(outcome.message);
      onChanged();
    }
  }

  return (
    <li className="retention-item" aria-label={title}>
      <p>
        <StatusBadge tone={item.active ? 'warning' : 'neutral'}>
          {item.active ? 'Active' : 'Released'}
        </StatusBadge>{' '}
        <strong>{title}</strong>
      </p>
      <p className="field-hint">
        {scope} · {by}
        {item.releasedBy && item.releasedAt
          ? ` · Released by ${who(item.releasedBy)} · ${formatExpiry(item.releasedAt)}: ${item.releaseReason}`
          : ''}
      </p>
      {canManage && item.active && !releasing ? (
        <button type="button" onClick={() => setReleasing(true)}>
          Release
        </button>
      ) : null}
      {releasing ? (
        <form aria-label="Release" onSubmit={(event) => void release(event)}>
          <label>
            Reason for releasing (required)
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="button" onClick={() => setReleasing(false)}>
            Cancel
          </button>{' '}
          <button type="submit" className="primary" disabled={!reason.trim()}>
            Release
          </button>
        </form>
      ) : null}
    </li>
  );
}
