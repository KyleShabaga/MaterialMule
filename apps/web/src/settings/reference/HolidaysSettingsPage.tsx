import {
  COMPANY_HOLIDAY_SOURCE_LABEL,
  concreteLabToday,
  type CompanyHoliday,
  type CompanyHolidayList,
  type FieldError,
} from '@materialmule/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DataTable, ErrorState, FormField, StatusBadge } from '../../components/ui';
import { createHoliday, fetchHolidays, removeHoliday, renameHoliday, type SaveResult } from './api';
import { SettingsHead } from '../SettingsHead';
import './reference-settings.css';

// Settings → Holidays (MM-V2-C37, owner decision 2026-11-08): the company holiday calendar,
// seeded with the Alberta general holidays. A concrete specimen target on one of these dates is
// flagged like a weekend and never moved. Everyone may look; admins add, rename and remove
// holidays (the server enforces the same rule). Removal needs a reason and is final.

export const HOLIDAYS_NOT_ALLOWED_TEXT = 'Only admins can change the holiday calendar.';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: CompanyHolidayList };

const WEEKDAY = new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'UTC' });
const weekdayOf = (date: string) => WEEKDAY.format(new Date(`${date}T00:00:00Z`));
const errorFor = (errors: FieldError[], field: string) =>
  errors.find((error) => error.field === field)?.message ?? null;

type Mode = { kind: 'add' } | { kind: 'rename'; id: string } | { kind: 'remove'; id: string };

function useSave(onSaved: (message: string) => void) {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<SaveResult<CompanyHoliday>>, success: string) => {
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const result = await action();
    setSaving(false);
    if (result.ok) onSaved(success);
    else if (result.kind === 'conflict') onSaved(result.message);
    else if (result.kind === 'invalid') {
      setErrors(result.errors);
      setMessage(result.message);
    } else setMessage(result.message);
  };
  return { errors, message, saving, run };
}

function Actions({
  saving,
  label,
  onCancel,
}: {
  saving: boolean;
  label: string;
  onCancel: () => void;
}) {
  return (
    <div className="form-actions">
      <button type="submit" className="primary" disabled={saving}>
        {saving ? 'Saving…' : label}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function Alert({ message }: { message: string | null }) {
  return message ? (
    <p className="field-error" role="alert">
      {message}
    </p>
  ) : null;
}

function AddForm({
  year,
  onSaved,
  onCancel,
}: {
  year: number;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => createHoliday({ holidayOn: date, name }), `${name.trim()} added.`);
  };
  return (
    <form className="inline-form" aria-label="Add a holiday" noValidate onSubmit={submit}>
      <h3>Add a holiday</h3>
      <FormField label="Date" required error={errorFor(errors, 'holidayOn')}>
        {(props) => (
          <input
            {...props}
            type="date"
            value={date}
            required
            min={`${year - 1}-01-01`}
            onChange={(e) => setDate(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Name" required error={errorFor(errors, 'name')}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={name}
            required
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <Actions saving={saving} label="Add holiday" onCancel={onCancel} />
      <Alert message={message} />
    </form>
  );
}

function RenameForm({
  holiday,
  onSaved,
  onCancel,
}: {
  holiday: CompanyHoliday;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(holiday.name);
  const { errors, message, saving, run } = useSave(onSaved);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => renameHoliday(holiday.id, { version: holiday.version, name }),
      'Holiday renamed.',
    );
  };
  return (
    <form
      className="inline-form"
      aria-label={`Rename ${holiday.name}`}
      noValidate
      onSubmit={submit}
    >
      <h3>
        Rename {holiday.name} ({holiday.holidayOn})
      </h3>
      <FormField label="Name" required error={errorFor(errors, 'name')}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={name}
            required
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <Actions saving={saving} label="Save name" onCancel={onCancel} />
      <Alert message={message} />
    </form>
  );
}

function RemoveForm({
  holiday,
  onSaved,
  onCancel,
}: {
  holiday: CompanyHoliday;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => removeHoliday(holiday.id, { version: holiday.version, reason }),
      `${holiday.name} removed.`,
    );
  };
  return (
    <form
      className="inline-form"
      aria-label={`Remove ${holiday.name}`}
      noValidate
      onSubmit={submit}
    >
      <h3>
        Remove {holiday.name} ({holiday.holidayOn})
      </h3>
      <p className="field-hint">
        Targets on this date will no longer be flagged as a holiday. Removal is final; the date can
        be added again later.
      </p>
      <FormField label="Reason" required error={errorFor(errors, 'reason')}>
        {(props) => (
          <textarea
            {...props}
            rows={2}
            value={reason}
            required
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </FormField>
      <Actions saving={saving} label="Remove holiday" onCancel={onCancel} />
      <Alert message={message} />
    </form>
  );
}

export function HolidaysSettingsPage() {
  const thisYear = Number(concreteLabToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void fetchHolidays(year).then((result) => {
      if (!live) return;
      setLoad(
        result.ok
          ? { state: 'ready', data: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      live = false;
    };
  }, [year, attempt]);

  if (load.state === 'loading') return <p aria-busy="true">Loading holidays…</p>;
  if (load.state === 'error') {
    return (
      <ErrorState
        message={load.message}
        onRetry={() => {
          setLoad({ state: 'loading' });
          reload();
        }}
      />
    );
  }
  const { items, canManage } = load.data;
  const saved = (message: string) => {
    setMode(null);
    setNotice(message);
    reload();
  };
  const chosen =
    mode && mode.kind !== 'add' ? (items.find((item) => item.id === mode.id) ?? null) : null;

  return (
    <>
      <p role="status" className="field-hint">
        {notice ?? ''}
      </p>
      <section className="settings-page" aria-labelledby="holidays-heading">
        <SettingsHead
          id="holidays-heading"
          title="Holiday calendar"
          who="Used to flag concrete break dates. Everyone can read it; administrators change it."
          actions={
            canManage && mode === null ? (
              <button type="button" className="primary" onClick={() => setMode({ kind: 'add' })}>
                Add a holiday
              </button>
            ) : null
          }
        />
        <div className="flag-only-note">
          <StatusBadge tone="waiting">Flag only</StatusBadge>
          <span>
            A break that lands on a holiday is flagged, the same way a weekend is. Its date is never
            moved for you.
          </span>
        </div>
        <p className="field-hint">
          A concrete specimen whose target lands on one of these dates keeps its target and is
          flagged as a holiday target, the same way as a weekend. The Alberta general holidays are
          listed for you; add any other day the office is closed.
        </p>
        <div className="year-switcher" role="group" aria-label="Year">
          <button type="button" onClick={() => setYear(year - 1)} aria-label="Previous year">
            ← {year - 1}
          </button>
          <strong aria-live="polite">{year}</strong>
          <button type="button" onClick={() => setYear(year + 1)} aria-label="Next year">
            {year + 1} →
          </button>
        </div>
        {mode?.kind === 'add' ? (
          <AddForm year={year} onSaved={saved} onCancel={() => setMode(null)} />
        ) : null}
        <DataTable
          caption={`Holidays in ${year}`}
          rows={items}
          rowKey={(row) => row.id}
          empty={`No holidays are listed for ${year}.`}
          columns={[
            { header: 'Date', cell: (row) => row.holidayOn },
            { header: 'Day', cell: (row) => weekdayOf(row.holidayOn) },
            { header: 'Holiday', cell: (row) => row.name },
            {
              header: 'Source',
              cell: (row) => (
                <StatusBadge tone={row.source === 'alberta_general' ? 'info' : 'neutral'}>
                  {COMPANY_HOLIDAY_SOURCE_LABEL[row.source]}
                </StatusBadge>
              ),
            },
            ...(canManage
              ? [
                  {
                    header: 'Actions',
                    cell: (row: CompanyHoliday) => (
                      <span className="row-actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setMode({ kind: 'rename', id: row.id })}
                        >
                          Rename {row.name}
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setMode({ kind: 'remove', id: row.id })}
                        >
                          Remove {row.name}
                        </button>
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {chosen && mode?.kind === 'rename' ? (
          <RenameForm
            key={chosen.id}
            holiday={chosen}
            onSaved={saved}
            onCancel={() => setMode(null)}
          />
        ) : null}
        {chosen && mode?.kind === 'remove' ? (
          <RemoveForm
            key={chosen.id}
            holiday={chosen}
            onSaved={saved}
            onCancel={() => setMode(null)}
          />
        ) : null}
        {canManage ? null : <p className="field-hint">{HOLIDAYS_NOT_ALLOWED_TEXT}</p>}
      </section>
    </>
  );
}
