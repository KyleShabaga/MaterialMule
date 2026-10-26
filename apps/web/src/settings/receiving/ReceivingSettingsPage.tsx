import {
  DRAFT_AUTO_DELETE_MAX_DAYS,
  DRAFT_AUTO_DELETE_MIN_DAYS,
  type DraftSettings,
} from '@trapezoid/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorState, FormField } from '../../components/ui';
import { useMe } from '../../session/context';
import { fetchDraftSettings, saveDraftSettings } from './api';

// Settings → Receiving (TRP-T40): draft auto-delete. Everyone may look; Admin and Lab Manager
// (`settings.drafts.manage`) may change it. The server enforces the same rule.

export const MANAGE_PERMISSION = 'settings.drafts.manage';
export const NOT_ALLOWED_TEXT = 'Only Lab Managers and administrators can change this.';
const DAYS_ERROR = `Enter a whole number of days from ${DRAFT_AUTO_DELETE_MIN_DAYS} to ${DRAFT_AUTO_DELETE_MAX_DAYS}`;

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; settings: DraftSettings };

/** The days field as typed; null when it isn't a whole number in range. */
function parseDays(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days >= DRAFT_AUTO_DELETE_MIN_DAYS && days <= DRAFT_AUTO_DELETE_MAX_DAYS ? days : null;
}

function DraftAutoDeleteForm({
  settings,
  allowed,
  onSaved,
}: {
  settings: DraftSettings;
  allowed: boolean;
  onSaved: (settings: DraftSettings, message: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(settings.draftAutoDelete.enabled);
  const [days, setDays] = useState(String(settings.draftAutoDelete.afterDays));
  const [daysError, setDaysError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const afterDays = parseDays(days);
    if (afterDays === null) {
      setDaysError(DAYS_ERROR);
      return;
    }
    setDaysError(null);
    setError(null);
    setSaving(true);
    const result = await saveDraftSettings({
      draftAutoDelete: { enabled, afterDays },
      version: settings.version,
    });
    setSaving(false);
    if (result.ok) {
      onSaved(result.data, 'Draft setting saved.');
    } else if (result.kind === 'conflict') {
      onSaved(result.current, result.message);
    } else if (result.kind === 'invalid') {
      const field = result.errors.find((e) => e.field === 'draftAutoDelete.afterDays');
      setDaysError(field ? field.message : null);
      setError(field ? null : result.message);
    } else {
      setError(result.message);
    }
  }

  return (
    <form
      className="card settings-form"
      aria-labelledby="draft-auto-delete-heading"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <h2 id="draft-auto-delete-heading">Receiving drafts</h2>
      <p>
        Drafts of receipts are kept only on the computer or phone where they were started. When
        automatic clean-up is on, each computer deletes its own drafts that haven&apos;t been saved
        for the chosen number of days the next time Receive samples is opened there, and says how
        many it deleted. Drafts whose confirmation was interrupted are never deleted.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!allowed}
          onChange={(e) => setEnabled(e.target.checked)}
        />{' '}
        Delete drafts automatically
      </label>
      <FormField
        label="After this many days without changes"
        hint={`${DRAFT_AUTO_DELETE_MIN_DAYS} to ${DRAFT_AUTO_DELETE_MAX_DAYS} days`}
        error={daysError}
      >
        {(props) => (
          <input
            {...props}
            type="number"
            inputMode="numeric"
            min={DRAFT_AUTO_DELETE_MIN_DAYS}
            max={DRAFT_AUTO_DELETE_MAX_DAYS}
            step={1}
            value={days}
            disabled={!allowed}
            onChange={(e) => setDays(e.target.value)}
          />
        )}
      </FormField>
      {allowed ? (
        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <p className="field-hint">{NOT_ALLOWED_TEXT}</p>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Settings → Receiving (TRP-T40). */
export function ReceivingSettingsPage() {
  const me = useMe();
  const allowed = me.permissions.includes(MANAGE_PERMISSION);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDraftSettings().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', settings: result.data }
          : { state: 'error', message: `The draft setting couldn't load. ${result.message}` },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (load.state === 'loading') return <p aria-busy="true">Loading receiving settings…</p>;
  if (load.state === 'error') {
    return (
      <ErrorState
        message={load.message}
        onRetry={() => {
          setLoad({ state: 'loading' });
          setAttempt((a) => a + 1);
        }}
      />
    );
  }
  return (
    <>
      <p role="status" className="field-hint">
        {notice ?? ''}
      </p>
      <DraftAutoDeleteForm
        key={load.settings.version}
        settings={load.settings}
        allowed={allowed}
        onSaved={(settings, message) => {
          setLoad({ state: 'ready', settings });
          setNotice(message);
        }}
      />
    </>
  );
}
