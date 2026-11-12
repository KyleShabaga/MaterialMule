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
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { DataTable, EmptyState, ErrorState, FormField, StatusBadge } from '../../components/app-ui';
import { SettingsHead } from '../SettingsHead';
import {
  fetchEquipment,
  fetchEquipmentList,
  recordCalibration,
  registerEquipment,
  updateEquipment,
  voidCalibration,
  type SaveResult,
} from './api';

// Settings → Equipment (MM-V2-C27, CD-44/CD-45): the one testing machine and the air meters, with
// their calibration history. Everyone may look; the Lab Manager registers, edits and records
// calibrations (the server enforces the same rule). Flags only warn: nothing here blocks work.
// The air-meter calibration form isn't mapped yet, so an entry holds only the date, next due date,
// who performed it and the result.

export const NOT_ALLOWED_TEXT = 'Only Lab Managers can change equipment.';

type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

const newKey = () => crypto.randomUUID();

function errorFor(errors: FieldError[], field: string): string | null {
  return errors.find((error) => error.field === field)?.message ?? null;
}

function Flags({ flags }: { flags: ConcreteEquipment['flagsToday'] }) {
  if (flags.length === 0) return <StatusBadge tone="success">No flags</StatusBadge>;
  return (
    <>
      {flags.map((flag) => (
        <StatusBadge key={flag} tone="warning">
          {CONCRETE_EQUIPMENT_FLAG_LABEL[flag]}
        </StatusBadge>
      ))}
    </>
  );
}

function statusTone(status: ConcreteEquipmentStatus) {
  return status === 'in_service' ? 'success' : status === 'retired' ? 'neutral' : 'danger';
}

function personText(person: { initials: string | null; name: string } | null): string {
  if (!person) return '—';
  return person.initials ? `${person.initials} · ${person.name}` : person.name;
}

/** Shared handling of a save: success, a conflict (show current), or field errors. */
function useSave(onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void) {
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
      onSaved(result.data, success);
      return true;
    }
    if (result.kind === 'conflict') onSaved(result.current, result.message);
    else if (result.kind === 'invalid') {
      setErrors(result.errors);
      setMessage(result.message);
    } else setMessage(result.message);
    return false;
  };
  return { errors, message, saving, run };
}

function FormError({ message }: { message: string | null }) {
  return message ? (
    <p className="field-error" role="alert">
      {message}
    </p>
  ) : null;
}

function TextInput({
  label,
  value,
  onChange,
  error,
  required = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
}) {
  return (
    <FormField label={label} error={error} required={required} hint={hint}>
      {(props) => (
        <input
          {...props}
          type="text"
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
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
  onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void;
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
    <form className="inline-form" aria-label={title} noValidate onSubmit={(e) => void submit(e)}>
      <h3>{title}</h3>
      <TextInput
        label={isMeter ? 'Air meter ID' : 'Equipment ID'}
        value={identifier}
        onChange={setIdentifier}
        required={isMeter}
        error={errorFor(errors, 'identifier')}
      />
      <TextInput label="Make" value={make} onChange={setMake} error={errorFor(errors, 'make')} />
      <TextInput
        label="Model"
        value={model}
        onChange={setModel}
        error={errorFor(errors, 'model')}
      />
      <TextInput
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
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Register'}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <FormError message={message} />
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// Detail: summary, edit, calibration history, change history
// -----------------------------------------------------------------------------------------------

function EditForm({
  detail,
  onSaved,
  onDone,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void;
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
      className="inline-form"
      aria-label="Edit equipment"
      noValidate
      onSubmit={(e) => void submit(e)}
    >
      <h3>Edit details</h3>
      <TextInput
        label={isMeter ? 'Air meter ID' : 'Equipment ID'}
        value={identifier}
        onChange={setIdentifier}
        required={isMeter}
        error={errorFor(errors, 'identifier')}
      />
      <TextInput label="Make" value={make} onChange={setMake} error={errorFor(errors, 'make')} />
      <TextInput
        label="Model"
        value={model}
        onChange={setModel}
        error={errorFor(errors, 'model')}
      />
      <TextInput
        label="Description"
        value={description}
        onChange={setDescription}
        error={errorFor(errors, 'description')}
      />
      <FormField label="Status" error={errorFor(errors, 'status')}>
        {(props) => (
          <select
            {...props}
            value={status}
            onChange={(e) => setStatus(e.target.value as ConcreteEquipmentStatus)}
          >
            {CONCRETE_EQUIPMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CONCRETE_EQUIPMENT_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {status !== 'in_service' ? (
        <TextInput
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
      <TextInput label="Reason for the change" value={reason} onChange={setReason} />
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <FormError message={message} />
    </form>
  );
}

function CalibrationForm({
  detail,
  onSaved,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void;
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
      setKey(newKey());
      setNextDueOn('');
      setPerformedBy('');
      setResult('');
    }
  }

  return (
    <form
      className="inline-form"
      aria-label="Record a calibration"
      noValidate
      onSubmit={(e) => void submit(e)}
    >
      <h3>Record a calibration</h3>
      <FormField label="Calibration date" required error={errorFor(errors, 'calibratedOn')}>
        {(props) => (
          <input
            {...props}
            type="date"
            required
            value={calibratedOn}
            onChange={(e) => setCalibratedOn(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Next calibration due"
        required
        error={errorFor(errors, 'nextDueOn')}
        hint="As stated on the calibration. Use after this date is flagged."
      >
        {(props) => (
          <input
            {...props}
            type="date"
            required
            value={nextDueOn}
            onChange={(e) => setNextDueOn(e.target.value)}
          />
        )}
      </FormField>
      <TextInput
        label="Performed by"
        value={performedBy}
        onChange={setPerformedBy}
        required
        error={errorFor(errors, 'performedBy')}
      />
      <TextInput
        label="Result"
        value={result}
        onChange={setResult}
        error={errorFor(errors, 'result')}
      />
      {detail.kind === 'air_meter' ? (
        <p className="field-hint">
          The air-meter calibration form hasn&apos;t been mapped yet; its readings will be added
          here once it is.
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Record calibration'}
        </button>
      </div>
      <FormError message={message} />
    </form>
  );
}

function VoidControl({
  detail,
  calibrationId,
  entryNumber,
  onSaved,
}: {
  detail: ConcreteEquipmentDetail;
  calibrationId: string;
  entryNumber: number;
  onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { errors, message, saving, run } = useSave(onSaved);
  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Void entry {entryNumber}
      </button>
    );
  }
  return (
    <form
      noValidate
      aria-label={`Void entry ${entryNumber}`}
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => voidCalibration(detail.kind, detail.id, calibrationId, reason),
          `Entry ${entryNumber} voided. It stays in the history.`,
        );
      }}
    >
      <TextInput
        label="Why void it"
        value={reason}
        onChange={setReason}
        required
        error={errorFor(errors, 'reason')}
      />
      <div className="form-actions">
        <button type="submit" className="danger" disabled={saving}>
          Void
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <FormError message={message} />
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

function EquipmentDetailView({
  detail,
  onSaved,
}: {
  detail: ConcreteEquipmentDetail;
  onSaved: (detail: ConcreteEquipmentDetail, notice: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const current = detail.currentCalibration;
  const rows: [string, ReactNode][] = [
    ['Equipment ID', detail.identifier ?? '—'],
    ['Make', detail.make ?? '—'],
    ['Model', detail.model ?? '—'],
    ['Description', detail.description ?? '—'],
    ...(detail.kind === 'air_meter'
      ? ([['Assigned technician', personText(detail.assignedTo)]] as [string, ReactNode][])
      : []),
    [
      'Status',
      <>
        <StatusBadge tone={statusTone(detail.status)}>
          {CONCRETE_EQUIPMENT_STATUS_LABEL[detail.status]}
        </StatusBadge>
        {detail.statusNote ? ` ${detail.statusNote}` : null}
      </>,
    ],
    ['Last calibration', current?.calibratedOn ?? 'None recorded'],
    ['Next calibration due', current?.nextDueOn ?? '—'],
    ['If used today', <Flags key="flags" flags={detail.flagsToday} />],
  ];
  const retired = detail.status === 'retired';
  return (
    <div>
      <dl className="details">
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {detail.canManage && !retired ? (
        editing ? (
          <EditForm
            key={detail.version}
            detail={detail}
            onSaved={onSaved}
            onDone={() => setEditing(false)}
          />
        ) : (
          <div className="form-actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit details
            </button>
          </div>
        )
      ) : null}

      <h3>Calibration history</h3>
      <DataTable
        caption="Calibration history"
        rows={detail.calibrations}
        rowKey={(row) => row.id}
        empty="No calibration recorded yet."
        columns={[
          { header: 'Entry', cell: (row) => row.entryNumber },
          { header: 'Calibrated', cell: (row) => row.calibratedOn },
          { header: 'Next due', cell: (row) => row.nextDueOn },
          { header: 'Performed by', cell: (row) => row.performedBy },
          { header: 'Result', cell: (row) => row.result ?? '—' },
          { header: 'Recorded by', cell: (row) => personText(row.recordedBy) },
          {
            header: 'State',
            cell: (row) =>
              row.voided ? (
                <>
                  <StatusBadge>Voided</StatusBadge> {row.voidReason}
                </>
              ) : detail.canManage ? (
                <VoidControl
                  detail={detail}
                  calibrationId={row.id}
                  entryNumber={row.entryNumber}
                  onSaved={onSaved}
                />
              ) : (
                'Recorded'
              ),
          },
        ]}
      />
      {detail.canManage && !retired ? (
        <CalibrationForm key={detail.id} detail={detail} onSaved={onSaved} />
      ) : null}

      <details>
        <summary>Change history ({detail.historyTotal})</summary>
        <ol className="status-history">
          {detail.history.map((event) => (
            <li key={event.id}>
              <strong>{ACTION_LABEL[event.action] ?? event.action}</strong>{' '}
              {new Date(event.occurredAt).toLocaleString()} · {personText(event.changedBy)}
              {event.reason ? ` · ${event.reason}` : null}
              {event.action === 'concrete_equipment.updated' ? (
                <ul>
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
      </details>
    </div>
  );
}

/** Loads one item's detail and keeps it current after each save. */
function EquipmentDetailLoader({
  id,
  onChanged,
}: {
  id: string;
  onChanged: (notice: string) => void;
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
  if (load.state === 'loading') return <p aria-busy="true">Loading equipment…</p>;
  if (load.state === 'error') return <ErrorState message={load.message} />;
  return (
    <EquipmentDetailView
      detail={load.data}
      onSaved={(detail, notice) => {
        setLoad({ state: 'ready', data: detail });
        onChanged(notice);
      }}
    />
  );
}

// -----------------------------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------------------------

/** Settings → Equipment (MM-V2-C27). */
export function EquipmentSettingsPage() {
  const [load, setLoad] = useState<Load<ConcreteEquipmentList>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMeter, setOpenMeter] = useState<string | null>(null);
  const [registeringMeter, setRegisteringMeter] = useState(false);

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

  if (load.state === 'loading') return <p aria-busy="true">Loading equipment…</p>;
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
  const machine = items.find((item) => item.kind === 'testing_machine') ?? null;
  const meters = items.filter((item) => item.kind === 'air_meter');
  const changed = (message: string) => {
    setNotice(message);
    reload();
  };

  return (
    <>
      <SettingsHead
        id="equipment-heading"
        title="Equipment"
        who="The testing machine and air meters used for concrete. Everyone can read this; Lab Managers change it."
      />
      <p role="status" className="field-hint">
        {notice ?? ''}
      </p>
      <section className="card" aria-labelledby="testing-machine-heading">
        <h2 id="testing-machine-heading">Testing machine</h2>
        <p className="field-hint">
          The lab has one testing machine, so tests never ask which machine was used. Use after the
          next calibration due date is flagged for review; it never stops work.
        </p>
        {machine ? (
          <EquipmentDetailLoader key={machine.id} id={machine.id} onChanged={changed} />
        ) : (
          <>
            <EmptyState>No testing machine is registered.</EmptyState>
            {canManage.testing_machine ? (
              <RegisterForm kind="testing_machine" onSaved={(_, message) => changed(message)} />
            ) : null}
          </>
        )}
        {canManage.testing_machine ? null : <p className="field-hint">{NOT_ALLOWED_TEXT}</p>}
      </section>

      <section className="card" aria-labelledby="air-meters-heading">
        <div className="section-header">
          <h2 id="air-meters-heading">Air meters</h2>
          {canManage.air_meter && !registeringMeter ? (
            <button type="button" onClick={() => setRegisteringMeter(true)}>
              Register an air meter
            </button>
          ) : null}
        </div>
        {registeringMeter ? (
          <RegisterForm
            kind="air_meter"
            onCancel={() => setRegisteringMeter(false)}
            onSaved={(detail, message) => {
              setRegisteringMeter(false);
              setOpenMeter(detail.id);
              changed(message);
            }}
          />
        ) : null}
        <DataTable
          caption="Air meters"
          rows={meters}
          rowKey={(row) => row.id}
          empty="No air meters are registered."
          columns={[
            { header: 'Air meter ID', cell: (row) => row.identifier },
            { header: 'Assigned technician', cell: (row) => personText(row.assignedTo) },
            {
              header: 'Status',
              cell: (row) => (
                <StatusBadge tone={statusTone(row.status)}>
                  {CONCRETE_EQUIPMENT_STATUS_LABEL[row.status]}
                </StatusBadge>
              ),
            },
            {
              header: 'Next calibration due',
              cell: (row) => row.currentCalibration?.nextDueOn ?? '—',
            },
            { header: 'If used today', cell: (row) => <Flags flags={row.flagsToday} /> },
            {
              header: 'Details',
              cell: (row) => (
                <button
                  type="button"
                  className="link-button"
                  aria-expanded={openMeter === row.id}
                  onClick={() => setOpenMeter(openMeter === row.id ? null : row.id)}
                >
                  {openMeter === row.id ? 'Close' : 'Open'} {row.identifier}
                </button>
              ),
            },
          ]}
        />
        {openMeter && meters.some((meter) => meter.id === openMeter) ? (
          <div className="inline-form" aria-label="Air meter details" role="region">
            <EquipmentDetailLoader key={openMeter} id={openMeter} onChanged={changed} />
          </div>
        ) : null}
        {canManage.air_meter ? null : <p className="field-hint">{NOT_ALLOWED_TEXT}</p>}
      </section>
    </>
  );
}
