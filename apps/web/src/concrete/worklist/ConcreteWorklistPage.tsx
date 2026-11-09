import {
  CONCRETE_EQUIPMENT_FLAG_LABEL,
  CONCRETE_HOLD_AGE,
  CONCRETE_WORKLIST_FLAG_LABEL,
  CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES,
  CONCRETE_WORKLIST_VIEWS,
  CONCRETE_WORKLIST_VIEW_LABEL,
  concreteTargetDateFlags,
  concreteRescheduledTarget,
  type ConcreteScheduleHistory,
  type ConcreteWorklist,
  type ConcreteWorklistFlag,
  type ConcreteWorklistGroup,
  type ConcreteWorklistRow,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  ConfirmDialog,
  DataTable,
  ErrorState,
  StatusBadge,
  TableScroll,
} from '../../components/ui';
import { fetchHolidayDates } from '../../settings/reference/api';
import { fetchConcreteWorklist, fetchScheduleHistory, rescheduleSpecimen } from './api';
import './concrete-worklist.css';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; list: ConcreteWorklist };

const FLAG_TONE: Record<ConcreteWorklistFlag, 'neutral' | 'warning' | 'danger' | 'info'> = {
  weekend_target: 'warning',
  holiday_target: 'warning',
  overdue: 'danger',
  hold_review_due: 'warning',
  rescheduled: 'info',
  report_draft: 'neutral',
};

const specimenLabel = (row: ConcreteWorklistRow) =>
  row.identity.permanentId ?? row.identity.temporaryId ?? `Unnumbered set, ${row.letter}`;

const ageLabel = (row: ConcreteWorklistRow) =>
  row.assignedAge === CONCRETE_HOLD_AGE ? 'HOLD' : `${row.assignedAge} d`;

/**
 * Lab Testing → Concrete breaks (MM-V2-C22): the daily lab worklist. Today (the default),
 * Overdue, Upcoming (7 days), HOLD and Exceptions, grouped by project with counts. Display only:
 * an overdue target is never moved, and a HOLD past its date is flagged for review, never tested
 * or disposed of. An authorized reschedule needs a reason and keeps the history.
 */
export function ConcreteWorklistPage() {
  const [view, setView] = useState<ConcreteWorklistView>('today');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // Each answer is kept with the request it answers, so one for an earlier view, page or retry
  // never fills the table (it reads as loading until the current answer arrives).
  const requestKey = `${view}|${projectId}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // Counts and the project list stay visible while the next view loads.
  const [last, setLast] = useState<ConcreteWorklist | null>(null);
  const [rescheduling, setRescheduling] = useState<ConcreteWorklistRow | null>(null);
  const [notice, setNotice] = useState('');
  const tabRefs = useRef<Partial<Record<ConcreteWorklistView, HTMLButtonElement | null>>>({});
  const baseId = useId();

  useEffect(() => {
    let current = true;
    fetchConcreteWorklist({ view, projectId, page }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setLast(result.data);
        setAnswer({ key: requestKey, load: { state: 'ready', list: result.data } });
      } else {
        setAnswer({ key: requestKey, load: { state: 'error', message: result.message } });
      }
    });
    return () => {
      current = false;
    };
  }, [view, projectId, page, requestKey]);

  function choose(next: ConcreteWorklistView, focus = false) {
    setView(next);
    setPage(1);
    if (focus) tabRefs.current[next]?.focus();
  }

  /** Arrow keys, Home and End move between the views (WAI-ARIA tabs). */
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = CONCRETE_WORKLIST_VIEWS.indexOf(view);
    const end = CONCRETE_WORKLIST_VIEWS.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? index === end
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? end
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? end
              : null;
    if (next === null) return;
    event.preventDefault();
    choose(CONCRETE_WORKLIST_VIEWS[next]!, true);
  }

  const list = load.state === 'ready' ? load.list : null;
  const counts = (list ?? last)?.counts;
  const projects = (list ?? last)?.projects ?? [];
  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <section aria-labelledby="concrete-worklist-heading" className="concrete-worklist">
      <h2 id="concrete-worklist-heading">Concrete breaks</h2>
      <p className="field-hint">
        {last ? <>Lab date {last.today} (America/Edmonton). </> : null}
        Weekend targets are flagged, never moved. Holidays aren’t flagged yet: the holiday list
        comes later.
      </p>
      <div className="worklist-filters">
        <label>
          Project{' '}
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.projectNumber}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div role="tablist" aria-label="Concrete worklist views" className="concrete-tabs">
        {CONCRETE_WORKLIST_VIEWS.map((v) => (
          <button
            key={v}
            ref={(node) => {
              tabRefs.current[v] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${v}`}
            aria-selected={view === v}
            aria-controls={`${baseId}-panel`}
            tabIndex={view === v ? 0 : -1}
            onClick={() => choose(v)}
            onKeyDown={onTabKey}
          >
            {CONCRETE_WORKLIST_VIEW_LABEL[v]}{' '}
            <span className="concrete-tab-count">{counts ? counts[v] : '…'}</span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${view}`}
        className="concrete-panel"
      >
        {notice ? (
          <p role="status" className="concrete-notice">
            {notice}
          </p>
        ) : null}
        {load.state === 'loading' ? <p aria-busy="true">Loading the worklist…</p> : null}
        {load.state === 'error' ? (
          <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
        ) : null}
        {list && view === 'exceptions' ? <Exceptions list={list} /> : null}
        {list && view !== 'exceptions' ? (
          list.groups.length === 0 ? (
            <p className="empty-state">{EMPTY[view]}</p>
          ) : (
            list.groups.map((group) => (
              <ProjectGroup
                key={group.projectId}
                group={group}
                view={view}
                onReschedule={(row) => {
                  setNotice('');
                  setRescheduling(row);
                }}
              />
            ))
          )
        ) : null}
        {list && list.total > list.pageSize ? (
          <nav className="pager" aria-label="Pages">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </nav>
        ) : null}
      </div>
      {rescheduling ? (
        <RescheduleDialog
          row={rescheduling}
          onCancel={() => setRescheduling(null)}
          onDone={(message) => {
            setRescheduling(null);
            setNotice(message);
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

const EMPTY: Record<Exclude<ConcreteWorklistView, 'exceptions'>, string> = {
  today: 'No concrete specimens are due today.',
  overdue: 'No specimens are overdue.',
  upcoming: 'No specimens are due in the next seven days.',
  hold: 'No specimens are on HOLD.',
};

function ProjectGroup({
  group,
  view,
  onReschedule,
}: {
  group: ConcreteWorklistGroup;
  view: Exclude<ConcreteWorklistView, 'exceptions'>;
  onReschedule: (row: ConcreteWorklistRow) => void;
}) {
  const headingId = useId();
  const caption = `${group.projectNumber} specimens`;
  return (
    <section aria-labelledby={headingId} className="concrete-group">
      <h3 id={headingId}>
        {group.projectNumber} · {group.projectName}{' '}
        <span className="concrete-group-count">
          {group.count} {group.count === 1 ? 'specimen' : 'specimens'}
        </span>
      </h3>
      <TableScroll label={caption}>
        <DataTable
          caption={caption}
          rows={group.rows}
          rowKey={(row) => row.specimenId}
          empty="None on this page."
          columns={[
            {
              header: 'Specimen',
              cell: (row) => <span className="mono">{specimenLabel(row)}</span>,
            },
            { header: 'Age', cell: ageLabel },
            { header: 'Cast', cell: (row) => row.castingDate },
            view === 'hold'
              ? { header: 'Hold until', cell: (row) => row.holdExpiresOn ?? '—' }
              : { header: 'Target', cell: (row) => row.targetDate ?? '—' },
            ...(view === 'overdue'
              ? [
                  {
                    header: 'Days late',
                    cell: (row: ConcreteWorklistRow) => row.daysOverdue ?? '—',
                  },
                ]
              : []),
            {
              header: 'Flags',
              cell: (row) => (
                <span className="concrete-flags">
                  {row.holdKind === 'ordinary' ? <StatusBadge>Ordinary HOLD</StatusBadge> : null}
                  {row.flags.map((flag) => (
                    <StatusBadge key={flag} tone={FLAG_TONE[flag]}>
                      {CONCRETE_WORKLIST_FLAG_LABEL[flag]}
                    </StatusBadge>
                  ))}
                </span>
              ),
            },
            {
              header: 'Actions',
              cell: (row) =>
                group.canReschedule && row.reschedulable ? (
                  <button
                    type="button"
                    className="compact"
                    aria-label={`Reschedule ${specimenLabel(row)}`}
                    onClick={() => onReschedule(row)}
                  >
                    Reschedule
                  </button>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </TableScroll>
    </section>
  );
}

function Exceptions({ list }: { list: ConcreteWorklist }) {
  return (
    <div className="concrete-exceptions">
      {!list.testingMachineRegistered ? (
        <p className="field-hint">No testing machine is registered (Settings → Equipment).</p>
      ) : null}
      {list.exceptions.length === 0 ? (
        <p className="empty-state">No open exceptions from the sources checked so far.</p>
      ) : (
        <ul className="concrete-exception-list">
          {list.exceptions.map((item) => (
            <li key={`${item.kind}-${item.equipmentId}`}>
              <strong>Testing machine: {item.label}</strong>{' '}
              {item.flags.map((flag) => (
                <StatusBadge key={flag} tone="warning">
                  {CONCRETE_EQUIPMENT_FLAG_LABEL[flag]}
                </StatusBadge>
              ))}
              {item.nextDueOn ? <> Next calibration due {item.nextDueOn}.</> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        Not checked here yet:{' '}
        {CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES.map((s) => s.label.toLowerCase()).join(', ')}.
      </p>
    </div>
  );
}

function RescheduleDialog({
  row,
  onCancel,
  onDone,
}: {
  row: ConcreteWorklistRow;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const [age, setAge] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ message: string; field?: 'newAge' | 'reason' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ConcreteScheduleHistory | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const ageId = useId();
  const reasonId = useId();
  const errorId = useId();

  useEffect(() => {
    let current = true;
    fetchScheduleHistory(row.specimenId).then((result) => {
      if (current && result.ok) setHistory(result.data);
    });
    return () => {
      current = false;
    };
  }, [row.specimenId]);

  // MM-V2-C37: the company holiday calendar, so the preview flags a holiday target too.
  const [holidays, setHolidays] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let current = true;
    void fetchHolidayDates().then((dates) => {
      if (current) setHolidays(dates);
    });
    return () => {
      current = false;
    };
  }, []);

  const days = /^\d{1,3}$/.test(age.trim()) ? Number(age.trim()) : null;
  const preview =
    days !== null && days >= 1 ? concreteRescheduledTarget(row.castingDate, days) : null;

  async function submit() {
    if (busy) return;
    if (days === null || days < 1) {
      setError({ message: 'Enter the new test age: 1 to 999 days.', field: 'newAge' });
      return;
    }
    if (reason.trim() === '') {
      setError({ message: 'A reason is required.', field: 'reason' });
      return;
    }
    setBusy(true);
    const result = await rescheduleSpecimen(row.specimenId, {
      idempotencyKey: key,
      version: history?.version ?? row.version,
      newAge: days,
      reason: reason.trim(),
    });
    setBusy(false);
    if (result.ok) {
      onDone(
        `Rescheduled ${specimenLabel(row)} to ${result.data.assignedAge} days (target ${result.data.targetDate}).`,
      );
    } else {
      setError(result);
    }
  }

  return (
    <ConfirmDialog
      open
      title={`Reschedule ${specimenLabel(row)}`}
      confirmLabel={busy ? 'Saving…' : 'Reschedule'}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <p>
        Now {ageLabel(row)} from casting on {row.castingDate}, target {row.targetDate}. The new
        target is the casting date plus the new age.
      </p>
      <div className="form-field">
        <label htmlFor={ageId}>New test age (days)</label>
        <input
          id={ageId}
          inputMode="numeric"
          value={age}
          onChange={(event) => setAge(event.target.value)}
          aria-invalid={error?.field === 'newAge' || undefined}
          aria-describedby={error?.field === 'newAge' ? errorId : undefined}
        />
      </div>
      {preview ? (
        <p role="status" className="field-hint">
          New target {preview}
          {concreteTargetDateFlags(preview).includes('weekend_target')
            ? ' (weekend target: kept and flagged)'
            : ''}
          {concreteTargetDateFlags(preview, holidays).includes('holiday_target')
            ? ' (holiday target: kept and flagged)'
            : ''}
          .
        </p>
      ) : null}
      <div className="form-field">
        <label htmlFor={reasonId}>Reason</label>
        <textarea
          id={reasonId}
          value={reason}
          rows={3}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={error?.field === 'reason' || undefined}
          aria-describedby={error?.field === 'reason' ? errorId : undefined}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="field-error">
          {error.message}
        </p>
      ) : null}
      {history && history.history.length > 0 ? (
        <details className="concrete-history">
          <summary>Schedule history ({history.history.length})</summary>
          <ul>
            {history.history.map((entry) => (
              <li key={entry.id}>
                {entry.previousAge} d ({entry.previousTargetDate}) → {entry.newAge} d (
                {entry.newTargetDate}) by {entry.by.initials ?? entry.by.name}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </ConfirmDialog>
  );
}
