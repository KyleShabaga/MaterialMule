import { useId, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { lookupStorageUnit } from './api';
import type { InventoryLinkState } from './InventoryPage';

/**
 * Manual entry of a storage unit ID (scanning reuses the same lookup, T16/T17). Sample Storage
 * shows it as "Look up ID"; the dashboard gives it a heading and a hint of its own.
 */
export function LookUpId({
  label = 'Look up ID',
  heading,
  hint,
  className = 'lookup-id',
}: {
  label?: string;
  /** Card title; the form is then named by it instead of by `label`. */
  heading?: string;
  hint?: string;
  className?: string;
}) {
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return;
    setBusy(true);
    setError(null);
    const result = await lookupStorageUnit(code);
    setBusy(false);
    if (result.ok) {
      navigate(`/sample-storage/${encodeURIComponent(result.data.readableId)}`, {
        state: {
          from: location.pathname === '/sample-storage' ? location.search : '',
        } satisfies InventoryLinkState,
      });
    } else {
      setError(result.notFound ? 'No storage unit found' : result.message);
    }
  }

  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      className={className}
      role={heading ? 'search' : undefined}
      aria-label={heading ? undefined : label}
      aria-labelledby={heading ? `${id}-heading` : undefined}
      onSubmit={(event) => void submit(event)}
    >
      {heading ? <h2 id={`${id}-heading`}>{heading}</h2> : null}
      <label htmlFor={id}>{label}</label>
      <div className="inline-input">
        <input
          id={id}
          type="text"
          value={code}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="e.g. BKT-2026-000014"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy || undefined}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          Open
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      ) : null}
    </form>
  );
}
