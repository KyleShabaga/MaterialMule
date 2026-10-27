import type { Printer } from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, FormField, StatusBadge } from '../components/ui';
import { useMe } from '../session/context';
import { fetchPrinters, savePrinters } from './api';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; printers: Printer[] };

const BLANK: Printer = {
  id: '',
  name: '',
  host: '',
  port: 9100,
  enabled: true,
  isDefault: false,
  checkStatus: true,
};

/** One printer's settings. New printers also choose their permanent ID. */
function PrinterForm({
  initial,
  isNew,
  onSaved,
}: {
  initial: Printer;
  isNew: boolean;
  onSaved: (printers: Printer[]) => void;
}) {
  const [draft, setDraft] = useState<Printer>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Printer>(key: K, value: Printer[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await savePrinters({ printers: [draft] });
    setSaving(false);
    if (result.ok) {
      if (isNew) setDraft(BLANK);
      onSaved(result.data);
    } else {
      setError(result.message);
    }
  }

  const title = isNew ? 'Add a printer' : draft.name || draft.id;
  return (
    // Banded like BandedCard (MM-T55), but the form itself is the named landmark.
    <form
      className={`banded-card printer-form${isNew ? ' printer-form-new' : ''}`}
      onSubmit={(event) => void submit(event)}
      aria-label={title}
    >
      <div className="banded-card-head">
        <div className="banded-card-titles">
          <h2 className="banded-card-title">{title}</h2>
          {isNew ? null : (
            <p className="banded-card-subtitle banded-card-meta">Printer ID: {initial.id}</p>
          )}
        </div>
        {isNew ? null : (
          <div className="banded-card-aside">
            {initial.enabled ? <StatusBadge tone="success">In use</StatusBadge> : null}
            {initial.isDefault ? <StatusBadge tone="info">Default</StatusBadge> : null}
          </div>
        )}
      </div>
      <div className="banded-card-body">
        {isNew ? (
          <FormField
            label="Printer ID"
            hint="Lowercase letters, digits and dashes. Can't change later."
          >
            {(props) => (
              <input
                {...props}
                value={draft.id}
                onChange={(e) => set('id', e.target.value)}
                required
              />
            )}
          </FormField>
        ) : null}
        <FormField label="Name">
          {(props) => (
            <input
              {...props}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          )}
        </FormField>
        <div className="field-pair field-pair-port">
          <FormField label="IP address or host name" hint="Fixed address from IT, e.g. 10.0.0.50">
            {(props) => (
              <input
                {...props}
                value={draft.host}
                onChange={(e) => set('host', e.target.value)}
                required
              />
            )}
          </FormField>
          <FormField label="Port" hint="Zebra raw printing uses 9100">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => set('port', Number(e.target.value))}
                required
              />
            )}
          </FormField>
        </div>
        <div className="checkbox-group">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />{' '}
            In use
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) => set('isDefault', e.target.checked)}
            />{' '}
            Default printer for labels
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.checkStatus}
              onChange={(e) => set('checkStatus', e.target.checked)}
            />{' '}
            Check printer status (paper, head, pause) before sending
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {isNew ? 'Add printer' : 'Save'}
          </button>
        </div>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Settings → Printers (admin, MM-T15). Addresses live only on the server. */
export function PrintersSettingsPage() {
  const me = useMe();
  const allowed = me.permissions.includes('printer.manage');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void fetchPrinters().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', printers: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, attempt]);

  if (!allowed) {
    return <EmptyState>Only administrators can change printers.</EmptyState>;
  }
  if (load.state === 'loading') return <p aria-busy="true">Loading printers…</p>;
  if (load.state === 'error') {
    return <ErrorState message={load.message} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  const onSaved = (printers: Printer[]) => {
    setLoad({ state: 'ready', printers });
    setSaved(true);
  };
  return (
    <>
      <p role="status" className={saved ? 'notice notice-success' : 'visually-hidden'}>
        {saved ? 'Printer settings saved.' : ''}
      </p>
      {/* Canvas layout (MM-T55): printers on the left, "Add a printer" beside them. */}
      <div className="printers-layout">
        <div className="printers-list">
          {load.printers.length === 0 ? (
            <EmptyState>
              No label printer yet. Add the ZD621 once IT has given it a fixed IP.
            </EmptyState>
          ) : null}
          {load.printers.map((printer) => (
            <PrinterForm
              key={`${printer.id}:${JSON.stringify(printer)}`}
              initial={printer}
              isNew={false}
              onSaved={onSaved}
            />
          ))}
        </div>
        <PrinterForm initial={BLANK} isNew onSaved={onSaved} />
      </div>
    </>
  );
}
