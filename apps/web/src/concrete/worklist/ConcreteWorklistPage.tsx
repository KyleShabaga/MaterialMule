import {
  CONCRETE_EQUIPMENT_FLAG_LABEL,
  CONCRETE_HOLD_AGE,
  CONCRETE_WORKLIST_FLAG_LABEL,
  CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES,
  CONCRETE_WORKLIST_VIEWS,
  concreteTargetDateFlags,
  concreteRescheduledTarget,
  type ConcreteScheduleHistory,
  type ConcreteWorklist,
  type ConcreteWorklistFlag,
  type ConcreteWorklistGroup,
  type ConcreteWorklistRow,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SectionHead,
  StatusBadge,
  TableScroll,
  TableViewSelector,
  type BadgeTone,
} from '../../components/app-ui';
import { useMediaQuery } from '../../components/useMediaQuery';
import { PHONE_QUERY, useTableView } from '../../components/useTableView';
import { FEATURES } from '../../features';
import { ContextRow } from '../../layout/ContextRow';
import { fetchHolidayDates } from '../../settings/reference/api';
import { TileBody } from '../ledger';
import { fetchConcreteWorklist, fetchScheduleHistory, rescheduleSpecimen } from './api';
import { SpecimenLabel } from './specimen';
import { specimenText } from './specimen-text';
import './concrete-worklist.css';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; list: ConcreteWorklist };

const FLAG_TONE: Record<ConcreteWorklistFlag, BadgeTone> = {
  weekend_target: 'closed',
  holiday_target: 'closed',
  overdue: 'danger',
  hold_review_due: 'waiting',
  rescheduled: 'lab',
  report_draft: 'waiting',
};

/** View tile names (docs/redesign/design.md, "Concrete (V2)": Today, Overdue, Next 7 days, HOLD, Exceptions). */
const VIEW_LABEL: Record<ConcreteWorklistView, string> = {
  today: 'Today',
  overdue: 'Overdue',
  upcoming: 'Next 7 days',
  hold: 'HOLD',
  exceptions: 'Exceptions',
};

const specimenLabel = (row: ConcreteWorklistRow) => specimenText(row.identity, row.letter);

const ageLabel = (row: ConcreteWorklistRow) =>
  row.assignedAge === CONCRETE_HOLD_AGE ? 'HOLD' : `${row.assignedAge} d`;

/**
 * Concrete → Breaks (MM-V2-C22): the daily lab worklist. Today (the default), Overdue, Next 7
 * days, HOLD and Exceptions as view tiles with counts, then one framed table per project. Display
 * only: an overdue target is never moved, and a HOLD past its date is flagged for review, never
 * tested or disposed of. An authorized reschedule needs a reason and keeps the history.
 */
export function ConcreteWorklistPage() {
  // MM-V2-C31: the Concrete dashboard opens a view (`?view=`), and HOLDs due for review
  // (`?view=hold&holdDue=true`); the tabs work as before after that.
  const [params] = useSearchParams();
  const [view, setView] = useState<ConcreteWorklistView>(() => {
    const asked = params.get('view');
    return (CONCRETE_WORKLIST_VIEWS as readonly string[]).includes(asked ?? '')
      ? (asked as ConcreteWorklistView)
      : 'today';
  });
  const [holdDue, setHoldDue] = useState(() => params.get('holdDue') === 'true');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // Each answer is kept with the request it answers, so one for an earlier view, page or retry
  // never fills the table (it reads as loading until the current answer arrives).
  const requestKey = `${view}|${holdDue}|${projectId}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // Counts and the project list stay visible while the next view loads.
  const [last, setLast] = useState<ConcreteWorklist | null>(null);
  const [rescheduling, setRescheduling] = useState<ConcreteWorklistRow | null>(null);
  const [notice, setNotice] = useState('');
  const [tableView, setTableView] = useTableView('concrete-breaks');
  const phone = useMediaQuery(PHONE_QUERY);
  const tabRefs = useRef<Partial<Record<ConcreteWorklistView, HTMLButtonElement | null>>>({});
  const baseId = useId();

  useEffect(() => {
    let current = true;
    fetchConcreteWorklist({ view, projectId, page, holdDue: view === 'hold' && holdDue }).then(
      (result) => {
        if (!current) return;
        if (result.ok) {
          setLast(result.data);
          setAnswer({ key: requestKey, load: { state: 'ready', list: result.data } });
        } else {
          setAnswer({ key: requestKey, load: { state: 'error', message: result.message } });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [view, holdDue, projectId, page, requestKey]);

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
  const onReschedule = (row: ConcreteWorklistRow) => {
    setNotice('');
    setRescheduling(row);
  };

  return (
    <div className="concrete-worklist">
      {/* The testing table is for the lab computers; on a phone the note below says so. */}
      {FEATURES.concreteLab && !phone ? (
        <ContextRow align="end">
          <Link className="button primary" to="/concrete/testing">
            Open testing table
          </Link>
        </ContextRow>
      ) : null}
      <PageHeader
        title="Concrete breaks"
        actions={<TableViewSelector value={tableView} onChange={setTableView} />}
      />
      {last ? (
        <p className="concrete-dateline">
          Lab date <span className="mono">{last.today}</span> (America/Edmonton)
        </p>
      ) : null}
      <div className="worklist-filters">
        <label className="worklist-project">
          <span className="field-label">Project</span>
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
      <div
        role="tablist"
        aria-label="Concrete worklist views"
        className="view-tiles concrete-tiles"
      >
        {CONCRETE_WORKLIST_VIEWS.map((v) => (
          <button
            key={v}
            ref={(node) => {
              tabRefs.current[v] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${v}`}
            aria-label={`${VIEW_LABEL[v]} ${counts ? counts[v] : '…'}`}
            aria-selected={view === v}
            aria-controls={`${baseId}-panel`}
            tabIndex={view === v ? 0 : -1}
            onClick={() => choose(v)}
            onKeyDown={onTabKey}
          >
            <TileBody count={counts ? counts[v] : '…'} label={VIEW_LABEL[v]} />
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${view}`}
        className="concrete-panel"
      >
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {load.state === 'loading' ? (
          <p className="field-hint" aria-busy="true">
            Loading the worklist…
          </p>
        ) : null}
        {load.state === 'error' ? (
          <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
        ) : null}
        {view === 'hold' && (list ?? last) ? (
          <label className="concrete-hold-due">
            <input
              type="checkbox"
              checked={holdDue}
              onChange={(event) => {
                setHoldDue(event.target.checked);
                setPage(1);
              }}
            />{' '}
            Only HOLDs due for review ({(list ?? last)!.holdReviewDue})
          </label>
        ) : null}
        {list && view === 'exceptions' ? <Exceptions list={list} /> : null}
        {list && view !== 'exceptions' ? (
          list.groups.length === 0 ? (
            <EmptyState>{EMPTY[view]}</EmptyState>
          ) : (
            list.groups.map((group) => (
              <ProjectGroup
                key={group.projectId}
                group={group}
                view={view}
                phone={phone}
                compact={tableView === 'compact'}
                onReschedule={onReschedule}
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
      {phone ? (
        <p className="concrete-footnote">
          Break results are entered at the lab computer, on the testing table.
        </p>
      ) : null}
      <p className="concrete-footnote">
        A target date is always the casting date plus the age. Weekend targets are flagged, never
        moved. Holidays aren’t flagged yet: the holiday list comes later. Nothing on HOLD is tested,
        released or disposed of automatically.
      </p>
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
    </div>
  );
}

const EMPTY: Record<Exclude<ConcreteWorklistView, 'exceptions'>, string> = {
  today: 'No concrete specimens are due today.',
  overdue: 'No specimens are overdue.',
  upcoming: 'No specimens are due in the next seven days.',
  hold: 'No specimens are on HOLD.',
};

/** The row's flags as status tags (an ordinary HOLD first). */
function Flags({ row }: { row: ConcreteWorklistRow }) {
  return (
    <span className="concrete-flags">
      {row.holdKind === 'ordinary' ? <StatusBadge tone="closed">Ordinary HOLD</StatusBadge> : null}
      {row.flags.map((flag) => (
        <StatusBadge key={flag} tone={FLAG_TONE[flag]}>
          {CONCRETE_WORKLIST_FLAG_LABEL[flag]}
        </StatusBadge>
      ))}
    </span>
  );
}

/** Reschedule, disabled with its reason, or nothing (no authority, or HOLD / draft). */
function RowAction({
  row,
  canReschedule,
  onReschedule,
}: {
  row: ConcreteWorklistRow;
  canReschedule: boolean;
  onReschedule: (row: ConcreteWorklistRow) => void;
}): ReactNode {
  if (canReschedule && row.reschedulable) {
    return (
      <button
        type="button"
        aria-label={`Reschedule ${specimenLabel(row)}`}
        onClick={() => onReschedule(row)}
      >
        Reschedule
      </button>
    );
  }
  if (canReschedule && needsNumber(row)) {
    // MM-V2-C38: past draft, an unnumbered set can't be rescheduled (server 409
    // `set_not_numbered`), so the action shows why instead of disappearing.
    return (
      <span className="concrete-action-blocked">
        <button
          type="button"
          disabled
          aria-label={`Reschedule ${specimenLabel(row)}`}
          aria-describedby={`needs-number-${row.specimenId}`}
        >
          Reschedule
        </button>
        <span id={`needs-number-${row.specimenId}`} className="concrete-action-reason">
          Number this set first
        </span>
      </span>
    );
  }
  return null;
}

function ProjectGroup({
  group,
  view,
  phone,
  compact,
  onReschedule,
}: {
  group: ConcreteWorklistGroup;
  view: Exclude<ConcreteWorklistView, 'exceptions'>;
  phone: boolean;
  compact: boolean;
  onReschedule: (row: ConcreteWorklistRow) => void;
}) {
  const headingId = useId();
  const caption = `${group.projectNumber} specimens`;
  const dateOf = (row: ConcreteWorklistRow) =>
    view === 'hold' ? (row.holdExpiresOn ?? '—') : (row.targetDate ?? '—');
  return (
    <section aria-labelledby={headingId} className="concrete-group">
      <SectionHead
        id={headingId}
        title={
          <>
            <span className="mono">{group.projectNumber}</span> · {group.projectName}
          </>
        }
        meta={`${group.count} ${group.count === 1 ? 'specimen' : 'specimens'}`}
      />
      {phone ? (
        // Phone (board PhoneConcrete): one stacked card per specimen.
        <ul className="concrete-cards" aria-label={caption}>
          {group.rows.map((row) => (
            <li key={row.specimenId} className="concrete-card">
              <div className="concrete-card-main">
                <SpecimenLabel identity={row.identity} letter={row.letter} />
                <span className="concrete-card-when">
                  {ageLabel(row)} · cast <span className="mono">{row.castingDate}</span> ·{' '}
                  {view === 'hold' ? 'hold until' : 'target'}{' '}
                  <span className="mono">{dateOf(row)}</span>
                  {view === 'overdue' && row.daysOverdue !== null ? (
                    <> · {row.daysOverdue} days late</>
                  ) : null}
                </span>
              </div>
              <Flags row={row} />
              <RowAction
                row={row}
                canReschedule={group.canReschedule}
                onReschedule={onReschedule}
              />
            </li>
          ))}
        </ul>
      ) : (
        <TableScroll label={caption} className="table-frame">
          <DataTable
            caption={caption}
            rows={group.rows}
            rowKey={(row) => row.specimenId}
            empty="None on this page."
            view={compact ? 'compact' : 'comfortable'}
            columns={[
              {
                header: 'Specimen',
                cell: (row) => <SpecimenLabel identity={row.identity} letter={row.letter} />,
              },
              { header: 'Age', cell: ageLabel },
              { header: 'Cast', cell: (row) => <span className="mono">{row.castingDate}</span> },
              view === 'hold'
                ? {
                    header: 'Hold until',
                    cell: (row) => <span className="mono">{row.holdExpiresOn ?? '—'}</span>,
                  }
                : {
                    header: 'Target',
                    cell: (row) => <span className="mono">{row.targetDate ?? '—'}</span>,
                  },
              ...(view === 'overdue'
                ? [
                    {
                      header: 'Days late',
                      cell: (row: ConcreteWorklistRow) => row.daysOverdue ?? '—',
                    },
                  ]
                : []),
              { header: 'Flags', cell: (row) => <Flags row={row} /> },
              {
                header: 'Actions',
                cell: (row) =>
                  RowAction({ row, canReschedule: group.canReschedule, onReschedule }) ?? '—',
              },
            ]}
          />
        </TableScroll>
      )}
    </section>
  );
}

/** An unnumbered set on a report past draft: rescheduling waits for its permanent number. */
function needsNumber(row: ConcreteWorklistRow): boolean {
  return (
    !row.reschedulable &&
    row.identity.permanentId === null &&
    row.reportState !== 'draft' &&
    row.assignedAge !== CONCRETE_HOLD_AGE
  );
}

function Exceptions({ list }: { list: ConcreteWorklist }) {
  return (
    <div className="concrete-exceptions">
      {!list.testingMachineRegistered ? (
        <Notice tone="warning">No testing machine is registered (Settings → Equipment).</Notice>
      ) : null}
      {list.exceptions.length === 0 ? (
        <EmptyState>No open exceptions from the sources checked so far.</EmptyState>
      ) : (
        <ul className="concrete-exception-list">
          {list.exceptions.map((item) => (
            <li key={`${item.kind}-${item.equipmentId}`}>
              <strong>Testing machine: {item.label}</strong>{' '}
              {item.flags.map((flag) => (
                <StatusBadge key={flag} tone="danger">
                  {CONCRETE_EQUIPMENT_FLAG_LABEL[flag]}
                </StatusBadge>
              ))}
              {item.nextDueOn ? (
                <span className="field-hint">
                  {' '}
                  Next calibration due <span className="mono">{item.nextDueOn}</span>.
                </span>
              ) : null}
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
