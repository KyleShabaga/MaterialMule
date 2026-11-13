import {
  CONCRETE_EQUIPMENT_FLAG_LABEL,
  CONCRETE_EQUIPMENT_STATUS_LABEL,
  CONCRETE_EQUIPMENT_STATUSES,
  type ConcreteEquipment,
  type ConcreteEquipmentDetail,
  type ConcreteEquipmentKind,
  type ConcreteEquipmentList,
  type ConcreteEquipmentStatus,
  type FieldError,
  type ReceiverOption,
} from '@materialmule/shared';
import { ChevronDown, Gauge, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldError as FieldErrorText, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { notifyError, notifySuccess } from '../../components/strata/toast';
import { FactList, FactRow } from '../account/ProfilePanel';
import { SettingsGroup, SettingsPanel } from '../modal/SettingsPanel';
import {
  CountLine,
  DrawerHead,
  FormActions,
  FormMessage,
  OpenItem,
  PanelError,
  PanelLoading,
  ReadOnlyNote,
  RecordSplit,
  StateBadge,
  TextField,
  TOUCH,
  type Tone,
} from '../reference/panel-parts';
import {
  fetchEquipment,
  fetchEquipmentList,
  recordCalibration,
  registerEquipment,
  updateEquipment,
  voidCalibration,
  type SaveResult,
} from './api';

// Settings › Equipment (MM-V2-C27, C36, CD-44/CD-45; STRATA-102, canvas R9ConcretePanel equipment
// and equipment-empty): the one testing machine and the air meters, with their calibration
// history. Everyone may read. The Lab Manager registers, edits and records calibrations for the
// testing machine; air meters also by Lab Technicians (C36). The server enforces both, and
// `canManage` comes from it. Flags only warn: nothing here blocks work. Units, readings and
// methods (G8) are open, so a calibration holds only its dates, who performed it and the result.

export const NOT_ALLOWED_TEXT = 'Only Lab Managers can change equipment.';
export const AIR_METERS_NOT_ALLOWED_TEXT =
  'Only Lab Managers and Lab Technicians can change air meters.';

type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

type Saved = (detail: ConcreteEquipmentDetail, notice: string, ok: boolean) => void;

const newKey = () => crypto.randomUUID();
const NEW = '__new__';

function errorFor(errors: FieldError[], field: string): string | null {
  return errors.find((error) => error.field === field)?.message ?? null;
}

function statusTone(status: ConcreteEquipmentStatus): Tone {
  return status === 'in_service' ? 'storage' : status === 'retired' ? 'closed' : 'danger';
}

function StatusBadge({ status }: { status: ConcreteEquipmentStatus }) {
  return (
    <StateBadge tone={statusTone(status)}>{CONCRETE_EQUIPMENT_STATUS_LABEL[status]}</StateBadge>
  );
}

function Flags({ flags }: { flags: ConcreteEquipment['flagsToday'] }) {
  if (flags.length === 0) return <StateBadge tone="storage">No flags</StateBadge>;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <StateBadge key={flag} tone="due">
          {CONCRETE_EQUIPMENT_FLAG_LABEL[flag]}
        </StateBadge>
      ))}
    </span>
  );
}

function personText(person: { initials: string | null; name: string } | null): string {
  if (!person) return '—';
  return person.initials ? `${person.initials} · ${person.name}` : person.name;
}

/** Shared handling of a save: success, a conflict (show current), or field errors. */
function useSave(onSaved: Saved) {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<SaveResult>, success: string) => {
    setSaving(true);
    setErrors([]);
    setMessage(null);
    const result = await action();
    setSaving(false);
    if (result.ok) {
      onSaved(result.data, success, true);
      return true;
    }
    if (result.kind === 'conflict') onSaved(result.current, result.message, false);
    else if (result.kind === 'invalid') {
      setErrors(result.errors);
      setMessage(result.message);
    } else setMessage(result.message);
    return false;
  };
  return { errors, message, saving, run };
}

function SubmitAndCancel({
  saving,
  label,
  onCancel,
  cancelLabel = 'Cancel',
  destructive = false,
}: {
  saving: boolean;
  label: string;
  onCancel?: () => void;
  cancelLabel?: string;
  destructive?: boolean;
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
      {onCancel ? (
        <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onCancel}>
          {cancelLabel}
        </Button>
      ) : null}
    </FormActions>
  );
}

function FormTitle({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold">{children}</h4>;
}

// -----------------------------------------------------------------------------------------------
// Register
// -----------------------------------------------------------------------------------------------

function RegisterForm({
  kind,
  onSaved,
  onCancel,
}: {
  kind: ConcreteEquipmentKind;
  onSaved: Saved;
  onCancel?: () => void;
}) {
  const [key] = useState(newKey);
  const [identifier, setIdentifier] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<ReceiverOption | null>(null);
  const { errors, message, saving, run } = useSave(onSaved);
  const isMeter = kind === 'air_meter';
  const title = isMeter ? 'Register an air meter' : 'Register the testing machine';

  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        registerEquipment({
          kind,
          identifier,
          make,
          model,
          description,
          ...(isMeter ? { assignedUserId: assignee?.id ?? null } : {}),
          idempotencyKey: key,
        }),
      isMeter ? 'Air meter registered.' : 'Testing machine registered.',
    );
  }

  return (
    <form
      aria-label={title}
      noValidate
      className="grid gap-5"
      onSubmit={(event) => void submit(event)}
    >
      {isMeter ? null : <FormTitle>{title}</FormTitle>}
      <TextField
        label={isMeter ? 'Air meter ID' : 'Equipment ID'}
        value={identifier}
        onChange={setIdentifier}
        required={isMeter}
        mono
        error={errorFor(errors, 'identifier')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="Make" value={make} onChange={setMake} error={errorFor(errors, 'make')} />
        <TextField
          label="Model"
          value={model}
          onChange={setModel}
          error={errorFor(errors, 'model')}
        />
      </div>
      <TextField
        label="Description"
        value={description}
        onChange={setDescription}
        error={errorFor(errors, 'description')}
      />
      {isMeter ? (
        <ReceiverSelect
          label="Assigned technician"
          value={assignee}
          onChange={setAssignee}
          error={errorFor(errors, 'assignedUserId')}
          hint="Field reports by this technician fill in this meter (they can change it)."
        />
      ) : null}
      <FormMessage message={message} />
      <SubmitAndCancel saving={saving} label="Register" onCancel={onCancel} />
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// Edit, calibrate, void
// -----------------------------------------------------------------------------------------------

function StatusField({
  value,
  onChange,
  error,
}: {
  value: ConcreteEquipmentStatus;
  onChange: (value: ConcreteEquipmentStatus) => void;
  error: string | null;
}) {
  const id = useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Status</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as ConcreteEquipmentStatus)}>
        <SelectTrigger
          id={id}
          className={`h-9 w-56 ${TOUCH}`}
          aria-invalid={error ? true : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONCRETE_EQUIPMENT_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {CONCRETE_EQUIPMENT_STATUS_LABEL[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <FieldErrorText>{error}</FieldErrorText> : null}
    </Field>
  );
}

function EditForm({
  detail,
  onSaved,
  onDone,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: Saved;
  onDone: () => void;
}) {
  const isMeter = detail.kind === 'air_meter';
  const [identifier, setIdentifier] = useState(detail.identifier ?? '');
  const [make, setMake] = useState(detail.make ?? '');
  const [model, setModel] = useState(detail.model ?? '');
  const [description, setDescription] = useState(detail.description ?? '');
  const [status, setStatus] = useState<ConcreteEquipmentStatus>(detail.status);
  const [statusNote, setStatusNote] = useState(detail.statusNote ?? '');
  const [assignee, setAssignee] = useState<ReceiverOption | null>(
    detail.assignedTo
      ? {
          id: detail.assignedTo.userId,
          initials: detail.assignedTo.initials ?? '',
          displayName: detail.assignedTo.name,
        }
      : null,
  );
  const [reason, setReason] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () =>
        updateEquipment(detail.kind, detail.id, {
          version: detail.version,
          identifier,
          make,
          model,
          description,
          status,
          statusNote: status === 'in_service' ? null : statusNote,
          ...(isMeter
            ? { assignedUserId: status === 'retired' ? null : (assignee?.id ?? null) }
            : {}),
          reason,
        }),
      'Equipment saved.',
    );
    if (saved) onDone();
  }

  return (
    <form
      aria-label="Edit equipment"
      noValidate
      className="grid gap-5 rounded-lg border p-4"
      onSubmit={(event) => void submit(event)}
    >
      <FormTitle>Edit details</FormTitle>
      <TextField
        label={isMeter ? 'Air meter ID' : 'Equipment ID'}
        value={identifier}
        onChange={setIdentifier}
        required={isMeter}
        mono
        error={errorFor(errors, 'identifier')}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="Make" value={make} onChange={setMake} error={errorFor(errors, 'make')} />
        <TextField
          label="Model"
          value={model}
          onChange={setModel}
          error={errorFor(errors, 'model')}
        />
      </div>
      <TextField
        label="Description"
        value={description}
        onChange={setDescription}
        error={errorFor(errors, 'description')}
      />
      <StatusField value={status} onChange={setStatus} error={errorFor(errors, 'status')} />
      {status !== 'in_service' ? (
        <TextField
          label="Why"
          value={statusNote}
          onChange={setStatusNote}
          required
          error={errorFor(errors, 'statusNote')}
          hint={
            status === 'retired'
              ? 'Retiring is final; the history stays.'
              : 'Use is flagged until it is back in service.'
          }
        />
      ) : null}
      {isMeter && status !== 'retired' ? (
        <ReceiverSelect
          label="Assigned technician"
          value={assignee}
          onChange={setAssignee}
          error={errorFor(errors, 'assignedUserId')}
        />
      ) : null}
      <TextField label="Reason for the change" value={reason} onChange={setReason} />
      <FormMessage message={message} />
      <SubmitAndCancel saving={saving} label="Save" onCancel={onDone} />
    </form>
  );
}

function CalibrationForm({
  detail,
  onSaved,
  onDone,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: Saved;
  onDone: () => void;
}) {
  const [key, setKey] = useState(newKey);
  const [calibratedOn, setCalibratedOn] = useState(detail.today);
  const [nextDueOn, setNextDueOn] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [result, setResult] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await run(
      () =>
        recordCalibration(detail.kind, detail.id, {
          calibratedOn,
          nextDueOn,
          performedBy,
          result,
          idempotencyKey: key,
        }),
      'Calibration recorded. Earlier entries stay in the history.',
    );
    if (saved) {
      // Stays open for the next entry, with a fresh idempotency key.
      setKey(newKey());
      setNextDueOn('');
      setPerformedBy('');
      setResult('');
    }
  }

  return (
    <form
      aria-label="Record a calibration"
      noValidate
      className="grid gap-5 rounded-lg border p-4"
      onSubmit={(event) => void submit(event)}
    >
      <FormTitle>Record a calibration</FormTitle>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Calibration date"
          type="date"
          required
          mono
          value={calibratedOn}
          onChange={setCalibratedOn}
          error={errorFor(errors, 'calibratedOn')}
        />
        <TextField
          label="Next calibration due"
          type="date"
          required
          mono
          value={nextDueOn}
          onChange={setNextDueOn}
          hint="As stated on the calibration. Use after this date is flagged."
          error={errorFor(errors, 'nextDueOn')}
        />
      </div>
      <TextField
        label="Performed by"
        value={performedBy}
        onChange={setPerformedBy}
        required
        error={errorFor(errors, 'performedBy')}
      />
      <TextField
        label="Result"
        value={result}
        onChange={setResult}
        error={errorFor(errors, 'result')}
      />
      {detail.kind === 'air_meter' ? (
        <p className="text-sm text-muted-foreground">
          The air-meter calibration form hasn’t been mapped yet; its readings will be added here
          once it is.
        </p>
      ) : null}
      <FormMessage message={message} />
      <SubmitAndCancel
        saving={saving}
        label="Record calibration"
        onCancel={onDone}
        cancelLabel="Done"
      />
    </form>
  );
}

function VoidForm({
  detail,
  calibrationId,
  entryNumber,
  onSaved,
  onCancel,
}: {
  detail: ConcreteEquipmentDetail;
  calibrationId: string;
  entryNumber: number;
  onSaved: Saved;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);
  return (
    <form
      noValidate
      aria-label={`Void entry ${entryNumber}`}
      className="grid gap-5 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => voidCalibration(detail.kind, detail.id, calibrationId, reason),
          `Entry ${entryNumber} voided. It stays in the history.`,
        );
      }}
    >
      <FormTitle>Void entry {entryNumber}</FormTitle>
      <TextField
        label="Why void it"
        value={reason}
        onChange={setReason}
        required
        hint="The entry stays in the history, marked voided."
        error={errorFor(errors, 'reason')}
      />
      <FormMessage message={message} />
      <SubmitAndCancel saving={saving} label="Void" destructive onCancel={onCancel} />
    </form>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'concrete_equipment.registered': 'Registered',
  'concrete_equipment.updated': 'Details changed',
  'concrete_equipment.calibration_recorded': 'Calibration recorded',
  'concrete_equipment.calibration_voided': 'Calibration voided',
};

function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object' && 'name' in (value as object)) {
    return personText(value as { initials: string | null; name: string });
  }
  if (typeof value === 'string' && value in CONCRETE_EQUIPMENT_STATUS_LABEL) {
    return CONCRETE_EQUIPMENT_STATUS_LABEL[value as ConcreteEquipmentStatus];
  }
  return String(value);
}

type Calibration = ConcreteEquipmentDetail['calibrations'][number];

// -----------------------------------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------------------------------

function EquipmentDetailView({
  detail,
  onSaved,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: Saved;
}) {
  const [form, setForm] = useState<'edit' | 'calibrate' | null>(null);
  const [voiding, setVoiding] = useState<Calibration | null>(null);
  const current = detail.currentCalibration;
  const retired = detail.status === 'retired';
  const manage = detail.canManage && !retired;

  const columns: DataTableColumn<Calibration>[] = [
    {
      id: 'entry',
      header: 'Entry',
      priority: 'identity',
      numeric: true,
      width: '3rem',
      cell: (row) => row.entryNumber,
    },
    {
      id: 'calibrated',
      header: 'Calibrated',
      priority: 'identity',
      mono: true,
      width: '10ch',
      cell: (row) => row.calibratedOn,
    },
    {
      id: 'due',
      header: 'Next due',
      priority: 'attribute',
      mono: true,
      width: '10ch',
      cell: (row) => row.nextDueOn,
    },
    {
      id: 'by',
      header: 'Performed by',
      priority: 'attribute',
      hideBelow: '40rem',
      cell: (row) => row.performedBy,
    },
    {
      id: 'result',
      header: 'Result',
      priority: 'attribute',
      hideBelow: '34rem',
      cell: (row) => row.result ?? '—',
    },
    {
      id: 'recorded',
      header: 'Recorded by',
      priority: 'attribute',
      hideBelow: '48rem',
      cell: (row) => personText(row.recordedBy),
    },
    {
      id: 'state',
      header: 'State',
      priority: 'state',
      control: true,
      wrap: true,
      width: '7rem',
      cell: (row) =>
        row.voided ? (
          <span className="grid gap-0.5">
            <StateBadge tone="closed">Voided</StateBadge>
            {row.voidReason ? (
              <span className="text-[13px] text-muted-foreground">{row.voidReason}</span>
            ) : null}
          </span>
        ) : detail.canManage ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => setVoiding(row)}
          >
            Void entry {row.entryNumber}
          </Button>
        ) : (
          'Recorded'
        ),
    },
  ];

  return (
    <div className="grid gap-6">
      <FactList>
        <FactRow label={detail.kind === 'air_meter' ? 'Air meter ID' : 'Equipment ID'} mono>
          {detail.identifier ?? '—'}
        </FactRow>
        <FactRow label="Make">{detail.make ?? '—'}</FactRow>
        <FactRow label="Model">{detail.model ?? '—'}</FactRow>
        <FactRow label="Description">{detail.description ?? '—'}</FactRow>
        {detail.kind === 'air_meter' ? (
          <FactRow label="Assigned technician">{personText(detail.assignedTo)}</FactRow>
        ) : null}
        <FactRow label="Status" hint={detail.statusNote ?? undefined}>
          <StatusBadge status={detail.status} />
        </FactRow>
        <FactRow label="Last calibration" mono>
          {current?.calibratedOn ?? 'None recorded'}
        </FactRow>
        <FactRow label="Next calibration due" mono>
          {current?.nextDueOn ?? '—'}
        </FactRow>
        <FactRow label="If used today">
          <Flags flags={detail.flagsToday} />
        </FactRow>
      </FactList>

      {manage && form === null ? (
        <FormActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH}
            onClick={() => setForm('calibrate')}
          >
            Record calibration
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={TOUCH}
            onClick={() => setForm('edit')}
          >
            Edit details
          </Button>
        </FormActions>
      ) : null}
      {manage && form === 'edit' ? (
        <EditForm
          key={detail.version}
          detail={detail}
          onSaved={onSaved}
          onDone={() => setForm(null)}
        />
      ) : null}
      {manage && form === 'calibrate' ? (
        <CalibrationForm
          key={detail.id}
          detail={detail}
          onSaved={onSaved}
          onDone={() => setForm(null)}
        />
      ) : null}

      <div className="grid gap-2">
        <FormTitle>Calibration history</FormTitle>
        <DataTable
          caption="Calibration history"
          columns={columns}
          data={detail.calibrations}
          getRowId={(row) => row.id}
          rowLabel={(row) => `Entry ${row.entryNumber}`}
          density="compact"
          freeColumnMin="8rem"
          empty="No calibration recorded yet."
        />
      </div>
      {voiding && detail.canManage ? (
        <VoidForm
          key={voiding.id}
          detail={detail}
          calibrationId={voiding.id}
          entryNumber={voiding.entryNumber}
          onSaved={(next, notice, ok) => {
            setVoiding(null);
            onSaved(next, notice, ok);
          }}
          onCancel={() => setVoiding(null)}
        />
      ) : null}

      <Collapsible className="grid gap-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={`group w-fit px-2 ${TOUCH}`}>
            <ChevronDown
              aria-hidden="true"
              className="transition-transform group-data-[state=closed]:-rotate-90"
            />
            Change history ({detail.historyTotal})
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="m-0 grid list-none gap-3 p-0">
            {detail.history.map((event) => (
              <li key={event.id} className="grid gap-0.5 text-sm">
                <span>
                  <span className="font-medium">{ACTION_LABEL[event.action] ?? event.action}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {new Date(event.occurredAt).toLocaleString()} · {personText(event.changedBy)}
                    {event.reason ? ` · ${event.reason}` : null}
                  </span>
                </span>
                {event.action === 'concrete_equipment.updated' ? (
                  <ul className="m-0 grid list-none gap-0.5 p-0 text-[13px] text-muted-foreground">
                    {Object.keys(event.after).map((field) => (
                      <li key={field}>
                        {field}: {describeValue(event.before[field])} →{' '}
                        {describeValue(event.after[field])}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Loads one item's detail and keeps it current after each save. */
function EquipmentDetailLoader({
  id,
  onChanged,
}: {
  id: string;
  onChanged: (notice: string, ok: boolean) => void;
}) {
  const [load, setLoad] = useState<Load<ConcreteEquipmentDetail>>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void fetchEquipment(id).then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', data: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (load.state === 'loading') return <PanelLoading label="Loading equipment…" />;
  if (load.state === 'error') return <PanelError message={load.message} />;
  return (
    <EquipmentDetailView
      detail={load.data}
      onSaved={(detail, notice, ok) => {
        setLoad({ state: 'ready', data: detail });
        onChanged(notice, ok);
      }}
    />
  );
}

// -----------------------------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------------------------

const METER_COLUMNS: DataTableColumn<ConcreteEquipment>[] = [
  {
    id: 'meter',
    header: 'Air meter',
    priority: 'identity',
    mono: true,
    width: '12ch',
    cell: (row) => row.identifier,
  },
  {
    id: 'assigned',
    header: 'Assigned technician',
    priority: 'attribute',
    hideBelow: '36rem',
    cell: (row) => personText(row.assignedTo),
  },
  {
    id: 'due',
    header: 'Next due',
    priority: 'attribute',
    hideBelow: '28rem',
    mono: true,
    width: '10ch',
    cell: (row) => row.currentCalibration?.nextDueOn ?? '—',
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'state',
    wrap: true,
    width: '9rem',
    cell: (row) => <StatusBadge status={row.status} />,
  },
  {
    id: 'flags',
    header: 'If used today',
    priority: 'attribute',
    hideBelow: '44rem',
    wrap: true,
    cell: (row) => <Flags flags={row.flagsToday} />,
  },
];

/** Settings › Equipment (everyone reads; MM-V2-C27/C36 permissions change). */
export function EquipmentPanel() {
  const [load, setLoad] = useState<Load<ConcreteEquipmentList>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [openMeter, setOpenMeter] = useState<string | null>(null);
  const [registeringMachine, setRegisteringMachine] = useState(false);
  const meterTitleId = useId();

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  useEffect(() => {
    let cancelled = false;
    void fetchEquipmentList().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', data: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const changed = (message: string, ok: boolean) => {
    if (ok) notifySuccess(message);
    else notifyError(message);
    reload();
  };

  const canManage = load.state === 'ready' ? load.data.canManage : null;
  const actions = canManage?.air_meter ? (
    <Button size="sm" className={TOUCH} onClick={() => setOpenMeter(NEW)}>
      <Plus aria-hidden="true" />
      Register an air meter
    </Button>
  ) : null;

  let body: ReactNode;
  if (load.state === 'loading') body = <PanelLoading label="Loading equipment…" />;
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
    const manage = load.data.canManage;
    const machine = items.find((item) => item.kind === 'testing_machine') ?? null;
    const meters = items.filter((item) => item.kind === 'air_meter');
    const meter = meters.find((item) => item.id === openMeter) ?? null;
    body = (
      <>
        <SettingsGroup id="equipment-testing-machine" title="Testing machine">
          <div className="grid gap-5 pt-4">
            <p className="text-sm text-muted-foreground">
              The lab has one testing machine, so tests never ask which machine was used. Use after
              the next calibration due date is flagged for review; it never stops work.
            </p>
            {machine ? (
              <EquipmentDetailLoader key={machine.id} id={machine.id} onChanged={changed} />
            ) : registeringMachine && manage.testing_machine ? (
              <RegisterForm
                kind="testing_machine"
                onCancel={() => setRegisteringMachine(false)}
                onSaved={(_, message, ok) => {
                  setRegisteringMachine(false);
                  changed(message, ok);
                }}
              />
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Gauge aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No testing machine is registered.</EmptyTitle>
                  <EmptyDescription>
                    Breaks can’t be recorded against it until it is.
                    {manage.testing_machine ? ' Register it here.' : ''}
                  </EmptyDescription>
                </EmptyHeader>
                {manage.testing_machine ? (
                  <EmptyContent>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={TOUCH}
                      onClick={() => setRegisteringMachine(true)}
                    >
                      Register the testing machine
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            )}
            {manage.testing_machine ? null : <ReadOnlyNote>{NOT_ALLOWED_TEXT}</ReadOnlyNote>}
          </div>
        </SettingsGroup>

        <SettingsGroup id="equipment-air-meters" title="Air meters">
          <div className="grid gap-3 pt-4">
            <CountLine>
              {meters.length === 1 ? '1 air meter' : `${meters.length} air meters`}
            </CountLine>
            <RecordSplit
              listLabel="Air meters"
              titleId={meterTitleId}
              openId={openMeter}
              onClose={() => setOpenMeter(null)}
              list={
                <DataTable
                  caption="Air meters"
                  columns={METER_COLUMNS}
                  data={meters}
                  getRowId={(row) => row.id}
                  rowLabel={(row) => row.identifier ?? 'Air meter'}
                  openRowId={openMeter}
                  onOpenRow={(row) => setOpenMeter(row.id)}
                  freeColumnMin="8rem"
                  empty="No air meters are registered."
                />
              }
              drawer={
                openMeter === NEW && manage.air_meter ? (
                  <>
                    <DrawerHead
                      titleId={meterTitleId}
                      eyebrow="Air meter"
                      title="Register an air meter"
                    />
                    <RegisterForm
                      kind="air_meter"
                      onCancel={() => setOpenMeter(null)}
                      onSaved={(detail, message, ok) => {
                        setOpenMeter(detail.id);
                        changed(message, ok);
                      }}
                    />
                  </>
                ) : meter ? (
                  <>
                    <DrawerHead
                      titleId={meterTitleId}
                      eyebrow="Air meter details"
                      title={meter.identifier}
                      aside={<StatusBadge status={meter.status} />}
                    />
                    <EquipmentDetailLoader key={meter.id} id={meter.id} onChanged={changed} />
                  </>
                ) : null
              }
            />
            <p className="text-sm text-muted-foreground">
              Use after the next calibration date is flagged on the field report.
            </p>
            {manage.air_meter ? null : <ReadOnlyNote>{AIR_METERS_NOT_ALLOWED_TEXT}</ReadOnlyNote>}
          </div>
        </SettingsGroup>

        <OpenItem title="Units, readings and methods (G8)">
          Not decided yet, so nothing here sets units or test methods. Equipment records only
          identity and calibration dates.
        </OpenItem>
      </>
    );
  }

  return (
    <SettingsPanel
      id="equipment"
      title="Equipment"
      description="The testing machine and air meters used for concrete. Everyone can read this; Lab Managers change it, and Lab Technicians also change air meters."
      actions={actions}
      wide
    >
      {body}
    </SettingsPanel>
  );
}
