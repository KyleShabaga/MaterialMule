import {
  COMPANY_HOLIDAY_SOURCE_LABEL,
  concreteLabToday,
  type CompanyHoliday,
  type CompanyHolidayList,
  type FieldError,
} from '@materialmule/shared';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { notifyError, notifySuccess } from '../../components/strata/toast';
import { SettingsPanel } from '../modal/SettingsPanel';
import { createHoliday, fetchHolidays, removeHoliday, renameHoliday, type SaveResult } from './api';
import {
  CountLine,
  DrawerHead,
  FormActions,
  FormMessage,
  PanelError,
  PanelLoading,
  ReadOnlyNote,
  RecordSplit,
  TextAreaField,
  TextField,
  TOUCH,
} from './panel-parts';

// Settings › Holidays (MM-V2-C37, owner decision 2026-11-08; STRATA-102, canvas R9ConcretePanel
// holidays): the company holiday calendar, seeded with the Alberta general holidays. A concrete
// specimen target on one of these dates is flagged like a weekend and never moved. Everyone may
// read; administrators add, rename and remove holidays (`concrete_settings.holiday.manage`,
// enforced by the server). Removal needs a reason and is final.

export const HOLIDAYS_NOT_ALLOWED_TEXT = 'Only admins can change the holiday calendar.';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: CompanyHolidayList };

type Mode = { kind: 'add' } | { kind: 'rename'; id: string } | { kind: 'remove'; id: string };

const WEEKDAY = new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'UTC' });
const weekdayOf = (date: string) => WEEKDAY.format(new Date(`${date}T00:00:00Z`));
const errorFor = (errors: FieldError[], field: string) =>
  errors.find((error) => error.field === field)?.message ?? null;

function useSave(onSaved: (message: string, ok: boolean) => void) {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<SaveResult<CompanyHoliday>>, success: string) => {
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const result = await action();
    setSaving(false);
    if (result.ok) onSaved(success, true);
    else if (result.kind === 'conflict') onSaved(result.message, false);
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
  destructive = false,
  onCancel,
}: {
  saving: boolean;
  label: string;
  destructive?: boolean;
  onCancel: () => void;
}) {
  return (
    <FormActions>
      <Button
        type="submit"
        size="sm"
        variant={destructive ? 'destructive' : 'default'}
        className={TOUCH}
        disabled={saving}
      >
        {saving ? 'Saving…' : label}
      </Button>
      <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onCancel}>
        Cancel
      </Button>
    </FormActions>
  );
}

interface FormProps {
  titleId: string;
  onSaved: (message: string, ok: boolean) => void;
  onCancel: () => void;
}

function AddForm({ year, titleId, onSaved, onCancel }: FormProps & { year: number }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => createHoliday({ holidayOn: date, name }), `${name.trim()} added.`);
  };
  return (
    <>
      <DrawerHead titleId={titleId} eyebrow="Company holiday" title="Add a holiday" />
      <form aria-label="Add a holiday" noValidate className="grid gap-5" onSubmit={submit}>
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={setDate}
          required
          min={`${year - 1}-01-01`}
          mono
          error={errorFor(errors, 'holidayOn')}
        />
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          required
          maxLength={200}
          error={errorFor(errors, 'name')}
        />
        <FormMessage message={message} />
        <Actions saving={saving} label="Add holiday" onCancel={onCancel} />
      </form>
    </>
  );
}

function RenameForm({
  holiday,
  titleId,
  onSaved,
  onCancel,
}: FormProps & { holiday: CompanyHoliday }) {
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
    <>
      <DrawerHead
        titleId={titleId}
        eyebrow={`${holiday.holidayOn} · ${weekdayOf(holiday.holidayOn)}`}
        title={`Rename ${holiday.name}`}
      />
      <form
        aria-label={`Rename ${holiday.name}`}
        noValidate
        className="grid gap-5"
        onSubmit={submit}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          required
          maxLength={200}
          error={errorFor(errors, 'name')}
        />
        <FormMessage message={message} />
        <Actions saving={saving} label="Save name" onCancel={onCancel} />
      </form>
    </>
  );
}

function RemoveForm({
  holiday,
  titleId,
  onSaved,
  onCancel,
}: FormProps & { holiday: CompanyHoliday }) {
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
    <>
      <DrawerHead
        titleId={titleId}
        eyebrow={`${holiday.holidayOn} · ${weekdayOf(holiday.holidayOn)}`}
        title={`Remove ${holiday.name}`}
      />
      <form
        aria-label={`Remove ${holiday.name}`}
        noValidate
        className="grid gap-5"
        onSubmit={submit}
      >
        <p className="text-sm text-muted-foreground">
          Targets on this date will no longer be flagged as a holiday. Removal is final; the date
          can be added again later.
        </p>
        <TextAreaField
          label="Reason"
          rows={2}
          value={reason}
          onChange={setReason}
          required
          maxLength={2000}
          error={errorFor(errors, 'reason')}
        />
        <FormMessage message={message} />
        <Actions saving={saving} label="Remove holiday" destructive onCancel={onCancel} />
      </form>
    </>
  );
}

/** Settings › Holidays (everyone reads; administrators change). */
export function HolidaysPanel() {
  const thisYear = Number(concreteLabToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const titleId = useId();

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

  const changeYear = (next: number) => {
    setMode(null);
    setYear(next);
  };
  const canManage = load.state === 'ready' && load.data.canManage;
  const actions = canManage ? (
    <Button size="sm" className={TOUCH} onClick={() => setMode({ kind: 'add' })}>
      <Plus aria-hidden="true" />
      Add a holiday
    </Button>
  ) : null;

  const yearSwitcher = (
    <div role="group" aria-label="Year" className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="pointer-coarse:size-11"
        aria-label="Previous year"
        title="Previous year"
        onClick={() => changeYear(year - 1)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span aria-live="polite" className="min-w-14 text-center font-mono text-base font-semibold">
        {year}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="pointer-coarse:size-11"
        aria-label="Next year"
        title="Next year"
        onClick={() => changeYear(year + 1)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );

  let body;
  if (load.state === 'loading') body = <PanelLoading label="Loading holidays…" />;
  else if (load.state === 'error') {
    body = (
      <PanelError
        message={load.message}
        onRetry={() => {
          setLoad({ state: 'loading' });
          reload();
        }}
      />
    );
  } else {
    const { items } = load.data;
    const saved = (message: string, ok: boolean) => {
      setMode(null);
      if (ok) notifySuccess(message);
      else notifyError(message);
      reload();
    };
    const chosen =
      mode && mode.kind !== 'add' ? (items.find((item) => item.id === mode.id) ?? null) : null;
    const openId = mode ? (mode.kind === 'add' ? 'add' : `${mode.kind}:${mode.id}`) : null;
    const columns: DataTableColumn<CompanyHoliday>[] = [
      {
        id: 'date',
        header: 'Date',
        priority: 'identity',
        mono: true,
        width: '10ch',
        cell: (row) => row.holidayOn,
      },
      {
        id: 'name',
        header: 'Holiday',
        priority: 'identity',
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        id: 'day',
        header: 'Day',
        priority: 'attribute',
        hideBelow: '36rem',
        width: '6.5rem',
        cell: (row) => weekdayOf(row.holidayOn),
      },
      {
        id: 'source',
        header: 'Source',
        priority: 'attribute',
        width: '11rem',
        cell: (row) => (
          <Badge variant={row.source === 'alberta_general' ? 'secondary' : 'outline'}>
            {COMPANY_HOLIDAY_SOURCE_LABEL[row.source]}
          </Badge>
        ),
      },
      ...(load.data.canManage
        ? [
            {
              id: 'actions',
              header: <span className="sr-only">Actions</span>,
              priority: 'state' as const,
              control: true,
              width: '5rem',
              cell: (row: CompanyHoliday) => (
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="pointer-coarse:size-11"
                    aria-label={`Rename ${row.name}`}
                    title={`Rename ${row.name}`}
                    onClick={() => setMode({ kind: 'rename', id: row.id })}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="pointer-coarse:size-11"
                    aria-label={`Remove ${row.name}`}
                    title={`Remove ${row.name}`}
                    onClick={() => setMode({ kind: 'remove', id: row.id })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </span>
              ),
            },
          ]
        : []),
    ];
    body = (
      <div className="grid gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">Flag only</Badge>
          <span>
            A break that lands on a holiday is flagged, the same way a weekend is. Its date is never
            moved for you. The Alberta general holidays are listed for you; add any other day the
            office is closed.
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {yearSwitcher}
          <CountLine>{items.length === 1 ? '1 holiday' : `${items.length} holidays`}</CountLine>
        </div>
        <RecordSplit
          listLabel={`Holidays in ${year}`}
          titleId={titleId}
          openId={openId}
          onClose={() => setMode(null)}
          list={
            <DataTable
              caption={`Holidays in ${year}`}
              columns={columns}
              data={items}
              getRowId={(row) => row.id}
              rowLabel={(row) => `${row.name} (${row.holidayOn})`}
              openRowId={chosen?.id ?? null}
              freeColumnMin="8rem"
              empty={`No holidays are listed for ${year}.`}
            />
          }
          drawer={
            mode?.kind === 'add' ? (
              <AddForm
                year={year}
                titleId={titleId}
                onSaved={saved}
                onCancel={() => setMode(null)}
              />
            ) : chosen && mode?.kind === 'rename' ? (
              <RenameForm
                key={chosen.id}
                holiday={chosen}
                titleId={titleId}
                onSaved={saved}
                onCancel={() => setMode(null)}
              />
            ) : chosen && mode?.kind === 'remove' ? (
              <RemoveForm
                key={chosen.id}
                holiday={chosen}
                titleId={titleId}
                onSaved={saved}
                onCancel={() => setMode(null)}
              />
            ) : null
          }
        />
        {load.data.canManage ? null : <ReadOnlyNote>{HOLIDAYS_NOT_ALLOWED_TEXT}</ReadOnlyNote>}
      </div>
    );
  }

  return (
    <SettingsPanel
      id="holidays"
      title="Holidays"
      description="Non-test days, used to flag concrete break dates. Everyone can read them; administrators change them."
      actions={actions}
      wide
    >
      {body}
    </SettingsPanel>
  );
}
