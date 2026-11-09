import {
  CONCRETE_TESTING_TABLE_COLUMNS,
  CONCRETE_TESTING_TABLE_COLUMN_LABEL,
  CONCRETE_TEST_RESULT_DIMENSION_UNITS,
  CONCRETE_TEST_RESULT_LOAD_UNITS,
  CONCRETE_WORKLIST_FLAG_LABEL,
  concreteTestEntryComplete,
  type ConcreteTestingTable,
  type ConcreteTestingTableColumn,
  type ConcreteTestingTableRow,
  type ConcreteWorklistFlag,
  type StaffOption,
} from '@materialmule/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router';
import { listActiveStaff } from '../../api/projects';
import { ErrorState, PageHeader, StatusBadge } from '../../components/ui';
import { useMe } from '../../session/context';
import { fetchTestingTable, saveTestResult } from './api';
import {
  STATUS_LABEL,
  editOf,
  initialRowState,
  isDirty,
  needsReason,
  planSave,
  tableResultOf,
  type CellField,
  type RowEdit,
  type RowState,
} from './row-state';
import './testing-table.css';

const HIDDEN_COLUMNS_KEY = 'materialmule.concreteTestingTable.hiddenColumns';
const NAV_FIELDS: (CellField | 'reason')[] = [
  'testedOn',
  'maxLoad',
  'height',
  'diameter',
  'reason',
];
const FIELD_COLUMN: Record<CellField, ConcreteTestingTableColumn> = {
  testedOn: 'testedOn',
  maxLoad: 'maxLoad',
  height: 'height',
  diameter: 'diameter',
};

const FLAG_TONE: Record<ConcreteWorklistFlag, 'neutral' | 'warning' | 'danger' | 'info'> = {
  weekend_target: 'warning',
  holiday_target: 'warning',
  overdue: 'danger',
  hold_review_due: 'warning',
  rescheduled: 'info',
  report_draft: 'neutral',
};

const LOAD_UNIT = CONCRETE_TEST_RESULT_LOAD_UNITS[0];
const DIMENSION_UNIT = CONCRETE_TEST_RESULT_DIMENSION_UNITS[0];

const labelOf = (row: ConcreteTestingTableRow) =>
  row.identity.permanentId ?? row.identity.temporaryId ?? `Unnumbered set, ${row.letter}`;

function readHidden(): Set<ConcreteTestingTableColumn> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(stored)) return new Set();
    return new Set(
      stored.filter((c): c is ConcreteTestingTableColumn =>
        (CONCRETE_TESTING_TABLE_COLUMNS as readonly string[]).includes(c as string),
      ),
    );
  } catch {
    return new Set();
  }
}

function writeHidden(hidden: Set<ConcreteTestingTableColumn>) {
  try {
    window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Browser storage is a convenience only.
  }
}

const timeFormat = new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit' });

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' };

/**
 * Concrete Lab → Testing table (MM-V2-C23): today's breaks for direct entry on the lab
 * computers. Grouped by project, sorted by set number (numeric) then letter. Keyboard first:
 * Tab moves across a row, Enter moves down a column, and a row saves when focus leaves it.
 * Incomplete rows are saved but not counted. A change to a saved value needs a reason; without
 * one nothing is sent and the typed value stays. Strength stays blank until C24 (owner gate G2);
 * units and readings are C07's provisional ones until G8.
 */
export function TestingTablePage() {
  const me = useMe();
  const canEnter = me.permissions.includes('concrete_test.enter');
  const sharedStation = me.accountType === 'shared_lab';

  const [includeOverdue, setIncludeOverdue] = useState(false);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [hidden, setHidden] = useState<Set<ConcreteTestingTableColumn>>(readHidden);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [table, setTable] = useState<ConcreteTestingTable | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // The rows as of the latest change, for saves that finish after a re-render.
  const rowsRef = useRef(rows);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [pageTesterId, setPageTesterId] = useState<string>('');
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(new Set<string>());
  const again = useRef(new Set<string>());

  // Testers: active staff with confirmed initials. A personal lab account starts as itself.
  useEffect(() => {
    let current = true;
    listActiveStaff()
      .then((list) => {
        if (!current) return;
        const testers = list.filter((person) => person.initials);
        setStaff(testers);
        if (!sharedStation && testers.some((p) => p.id === me.id)) {
          setPageTesterId((value) => value || me.id);
        }
      })
      .catch(() => {
        if (current) setStaff([]);
      });
    return () => {
      current = false;
    };
  }, [me.id, sharedStation]);

  useEffect(() => {
    let current = true;
    void fetchTestingTable({ includeOverdue }).then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        setLoad({ state: 'error', message: answer.message });
        return;
      }
      setTable(answer.data);
      // Rows with unsaved or failed edits keep them across a reload.
      setRows((previous) => {
        const next: Record<string, RowState> = {};
        rowsRef.current = next;
        for (const row of answer.data.groups.flatMap((g) => g.rows)) {
          const kept = previous[row.specimenId];
          next[row.specimenId] =
            kept && kept.status !== 'saved' && kept.status !== 'empty'
              ? kept
              : initialRowState(row, () => crypto.randomUUID());
        }
        return next;
      });
      setLoad({ state: 'ready' });
    });
    return () => {
      current = false;
    };
  }, [includeOverdue, attempt]);

  const update = useCallback((specimenId: string, change: (state: RowState) => RowState) => {
    setRows((previous) => {
      const state = previous[specimenId];
      if (!state) return previous;
      const next = { ...previous, [specimenId]: change(state) };
      rowsRef.current = next;
      return next;
    });
  }, []);

  const today = table?.today ?? '';

  /** Save one row (when focus leaves it, or Retry). One save per row at a time. */
  async function commit(specimenId: string): Promise<void> {
    if (!canEnter) return;
    if (inFlight.current.has(specimenId)) {
      again.current.add(specimenId);
      return;
    }
    const state = rowsRef.current[specimenId];
    if (!state) return;
    const plan = planSave(state, {
      today,
      pageTesterId: pageTesterId || null,
      sharedStation,
    });
    if (plan.kind === 'none') {
      if (state.status === 'pending' || state.status === 'reason') {
        update(specimenId, (s) => ({
          ...s,
          status: s.row.result ? 'saved' : 'empty',
          message: null,
        }));
      }
      return;
    }
    if (plan.kind === 'invalid') {
      update(specimenId, (s) => ({ ...s, status: 'failed', message: plan.message }));
      return;
    }
    if (plan.kind === 'reason') {
      update(specimenId, (s) => ({
        ...s,
        status: 'reason',
        message: 'Say why the saved value is being changed',
      }));
      return;
    }
    const bodyText = JSON.stringify(plan.body);
    const key =
      state.lastSent && state.lastSent.body === bodyText ? state.lastSent.key : crypto.randomUUID();
    const sentEdit = state.edit;
    inFlight.current.add(specimenId);
    update(specimenId, (s) => ({
      ...s,
      status: 'saving',
      message: null,
      lastSent: { key, body: bodyText },
    }));
    const outcome = await saveTestResult(specimenId, state.resultId, {
      idempotencyKey: key,
      ...plan.body,
    });
    inFlight.current.delete(specimenId);
    if (outcome.ok) {
      const result = tableResultOf(outcome.result);
      update(specimenId, (s) => {
        const row = { ...s.row, result, complete: concreteTestEntryComplete(result) };
        const typedSince = JSON.stringify(s.edit) !== JSON.stringify(sentEdit);
        return {
          ...s,
          row,
          resultId: result.id,
          edit: typedSince ? s.edit : editOf(result),
          status: typedSince ? 'pending' : 'saved',
          message: null,
          lastSent: null,
        };
      });
    } else if (outcome.kind === 'reason_required') {
      update(specimenId, (s) => ({
        ...s,
        status: 'reason',
        message: 'Say why the saved value is being changed',
      }));
    } else {
      // AC2: a failed save keeps every typed value. After a version conflict the row compares
      // against the server's copy from now on (a change to its values then needs a reason).
      const current = outcome.current ? tableResultOf(outcome.current) : null;
      update(specimenId, (s) => ({
        ...s,
        ...(current && current.id === s.resultId
          ? { row: { ...s.row, result: current, complete: concreteTestEntryComplete(current) } }
          : {}),
        status: 'failed',
        message: outcome.message,
      }));
    }
    if (again.current.delete(specimenId)) void commit(specimenId);
  }

  function onCellChange(specimenId: string, field: keyof RowEdit, value: string) {
    update(specimenId, (s) => {
      const edit = { ...s.edit, [field]: value };
      const dirty = isDirty({ row: s.row, edit });
      if (s.status === 'saving') return { ...s, edit };
      if (!dirty && field !== 'reason') {
        return { ...s, edit, status: s.row.result ? 'saved' : 'empty', message: null };
      }
      if (s.status === 'reason') return { ...s, edit };
      return { ...s, edit, status: 'pending', message: null };
    });
  }

  function onRowBlur(specimenId: string, event: FocusEvent<HTMLTableRowElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setActiveRow((value) => (value === specimenId ? null : value));
    void commit(specimenId);
  }

  /** Enter / Shift+Enter move to the same column in the next / previous row. */
  function onCellKey(event: KeyboardEvent<HTMLInputElement>, index: number, field: string) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const container = containerRef.current;
    if (!container) return;
    const all = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[data-nav-row][data-nav-field]'),
    );
    const want = field === 'reason' ? NAV_FIELDS[0]! : field;
    const target = all.find(
      (input) => Number(input.dataset.navRow) === index + step && input.dataset.navField === want,
    );
    if (target) {
      target.focus();
      target.select();
    } else {
      // The last row: leaving the field still saves the row.
      event.currentTarget.blur();
    }
  }

  function toggleColumn(column: ConcreteTestingTableColumn) {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      writeHidden(next);
      return next;
    });
  }

  const show = (column: ConcreteTestingTableColumn) => !hidden.has(column);

  const groups = useMemo(
    () => (table?.groups ?? []).filter((g) => projectId === '' || g.projectId === projectId),
    [table, projectId],
  );
  const all = useMemo(
    () =>
      groups
        .flatMap((g) => g.rows.map((r) => rows[r.specimenId]))
        .filter((s): s is RowState => s !== undefined),
    [groups, rows],
  );
  const completed = all.filter((s) => s.row.complete).length;
  const visible = (state: RowState) =>
    !(
      hideCompleted &&
      state.row.complete &&
      state.status === 'saved' &&
      activeRow !== state.row.specimenId
    );
  // Rows are numbered across all visible groups for Enter navigation.
  const navIndexOf = new Map(all.filter(visible).map((s, i) => [s.row.specimenId, i]));

  return (
    <section aria-label="Testing table" className="testing-table-page">
      <PageHeader title="Testing table" />
      <p className="field-hint">
        {table ? <>Lab date {table.today} (America/Edmonton). </> : null}
        Tab moves across a row, Enter moves down a column; a row saves when you leave it. Strength
        is calculated later (not yet confirmed). Units are provisional ({LOAD_UNIT},{' '}
        {DIMENSION_UNIT}); separate several readings with spaces.
      </p>
      {!canEnter ? (
        <p className="testing-note" role="note">
          You can view this table. Entering results needs a Lab Technician, Lab Manager or the LAB
          station.
        </p>
      ) : null}
      <div className="testing-toolbar">
        <label className="testing-tester">
          Tested by{sharedStation ? ' (required on this station)' : ''}{' '}
          <select
            value={pageTesterId}
            onChange={(event) => setPageTesterId(event.target.value)}
            disabled={!canEnter}
          >
            <option value="">Choose…</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.initials} · {person.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project{' '}
          <select
            aria-label="Project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">All</option>
            {(table?.groups ?? []).map((group) => (
              <option key={group.projectId} value={group.projectId}>
                {group.projectNumber}
              </option>
            ))}
          </select>
        </label>
        <label className="testing-toggle">
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={(event) => setHideCompleted(event.target.checked)}
          />{' '}
          Hide completed
        </label>
        <label className="testing-toggle">
          <input
            type="checkbox"
            checked={includeOverdue}
            onChange={(event) => {
              setLoad({ state: 'loading' });
              setIncludeOverdue(event.target.checked);
            }}
          />{' '}
          Include overdue
        </label>
        <details className="testing-columns">
          <summary>Columns</summary>
          <fieldset>
            <legend>Show columns</legend>
            {CONCRETE_TESTING_TABLE_COLUMNS.map((column) => (
              <label key={column}>
                <input
                  type="checkbox"
                  checked={show(column)}
                  onChange={() => toggleColumn(column)}
                />{' '}
                {CONCRETE_TESTING_TABLE_COLUMN_LABEL[column]}
              </label>
            ))}
          </fieldset>
        </details>
        <p className="testing-progress" aria-live="polite">
          {table ? `${completed} of ${all.length} completed` : null}
        </p>
      </div>
      {load.state === 'loading' && !table ? <p aria-busy="true">Loading today’s breaks…</p> : null}
      {load.state === 'error' ? (
        <ErrorState
          message={load.message}
          onRetry={() => {
            setLoad({ state: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
      {table && all.length === 0 ? (
        <p className="empty-state">
          No breaks {includeOverdue ? 'due today or overdue' : 'due today'}.
        </p>
      ) : null}
      {table?.truncated ? (
        <p className="testing-note" role="note">
          Showing the first {table.total} rows. Narrow the list (turn off Include overdue) to see
          the rest.
        </p>
      ) : null}
      <div ref={containerRef}>
        {groups.map((group) => {
          const states = group.rows
            .map((row) => rows[row.specimenId])
            .filter((s): s is RowState => s !== undefined);
          const shown = states.filter(visible);
          const done = states.filter((s) => s.row.complete).length;
          return (
            <section
              key={group.projectId}
              className="testing-group"
              aria-labelledby={`testing-group-${group.projectId}`}
            >
              <h2 id={`testing-group-${group.projectId}`}>
                {group.projectNumber} · {group.projectName}{' '}
                <span className="testing-group-count">
                  {done}/{states.length} done
                </span>
              </h2>
              {shown.length === 0 ? (
                <p className="empty-state">All completed rows are hidden.</p>
              ) : (
                <div className="testing-scroll">
                  <table className="testing-table">
                    <caption className="visually-hidden">Breaks for {group.projectNumber}</caption>
                    <thead>
                      <tr>
                        {show('project') ? <th scope="col">Project</th> : null}
                        <th scope="col">Specimen</th>
                        {show('age') ? <th scope="col">Age (assigned / actual)</th> : null}
                        {show('testedOn') ? <th scope="col">Test date</th> : null}
                        {show('tester') ? <th scope="col">Tested by</th> : null}
                        {show('maxLoad') ? <th scope="col">Max load ({LOAD_UNIT})</th> : null}
                        {show('height') ? <th scope="col">Height ({DIMENSION_UNIT})</th> : null}
                        {show('diameter') ? <th scope="col">Diameter ({DIMENSION_UNIT})</th> : null}
                        {show('strength') ? (
                          <th scope="col" title="Calculated later: the method isn’t confirmed yet">
                            Strength
                          </th>
                        ) : null}
                        {show('flags') ? <th scope="col">Flags</th> : null}
                        <th scope="col">Save status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((state) => {
                        return (
                          <TestingRow
                            key={state.row.specimenId}
                            state={state}
                            index={navIndexOf.get(state.row.specimenId) ?? -1}
                            projectNumber={group.projectNumber}
                            show={show}
                            canEnter={canEnter}
                            today={today}
                            pageTester={staff.find((p) => p.id === pageTesterId) ?? null}
                            onChange={onCellChange}
                            onBlur={onRowBlur}
                            onFocus={setActiveRow}
                            onKey={onCellKey}
                            onRetry={(id) => void commit(id)}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function TestingRow({
  state,
  index,
  projectNumber,
  show,
  canEnter,
  today,
  pageTester,
  onChange,
  onBlur,
  onFocus,
  onKey,
  onRetry,
}: {
  state: RowState;
  index: number;
  projectNumber: string;
  show: (column: ConcreteTestingTableColumn) => boolean;
  canEnter: boolean;
  today: string;
  pageTester: StaffOption | null;
  onChange: (specimenId: string, field: keyof RowEdit, value: string) => void;
  onBlur: (specimenId: string, event: FocusEvent<HTMLTableRowElement>) => void;
  onFocus: (specimenId: string) => void;
  onKey: (event: KeyboardEvent<HTMLInputElement>, index: number, field: string) => void;
  onRetry: (specimenId: string) => void;
}) {
  const { row, edit, status } = state;
  const label = labelOf(row);
  const reason = canEnter && (status === 'reason' || needsReason(state, today));
  const overdue = row.flags.includes('overdue');

  const cell = (field: CellField, name: string, placeholder?: string) =>
    show(FIELD_COLUMN[field]) ? (
      <td>
        <input
          type="text"
          inputMode={field === 'testedOn' ? 'text' : 'decimal'}
          aria-label={`${name} ${label}`}
          value={edit[field]}
          placeholder={placeholder}
          readOnly={!canEnter}
          data-nav-row={index}
          data-nav-field={field}
          autoComplete="off"
          onChange={(event) => onChange(row.specimenId, field, event.target.value)}
          onKeyDown={(event) => onKey(event, index, field)}
        />
      </td>
    ) : null;

  const statusText =
    status === 'saved' && !row.complete ? 'Saved · incomplete' : STATUS_LABEL[status];
  const tone =
    status === 'failed' || status === 'reason'
      ? 'danger'
      : status === 'saved'
        ? row.complete
          ? 'success'
          : 'warning'
        : status === 'empty'
          ? 'neutral'
          : 'info';

  return (
    <tr
      className={`testing-row testing-row-${status}${overdue ? ' testing-row-overdue' : ''}`}
      data-specimen={label}
      onBlur={(event) => onBlur(row.specimenId, event)}
      onFocus={() => onFocus(row.specimenId)}
    >
      {show('project') ? <td>{projectNumber}</td> : null}
      <th scope="row" className="testing-id">
        {label}
      </th>
      {show('age') ? (
        <td>
          {row.assignedAge} d / {row.actualAge} d
          {row.daysOverdue ? <span className="testing-sub">target {row.targetDate}</span> : null}
        </td>
      ) : null}
      {cell('testedOn', 'Test date', row.result ? undefined : today)}
      {show('tester') ? (
        <td>
          {row.result?.tester ? (
            <span title={row.result.tester.name}>{row.result.tester.initials}</span>
          ) : pageTester ? (
            <span className="testing-sub" title="Recorded when the row saves">
              {pageTester.initials}
            </span>
          ) : (
            <span className="testing-sub">—</span>
          )}
        </td>
      ) : null}
      {cell('maxLoad', 'Max load')}
      {cell('height', 'Height')}
      {cell('diameter', 'Diameter')}
      {show('strength') ? (
        <td className="testing-strength" aria-label={`Strength ${label}: not calculated yet`}>
          {' '}
        </td>
      ) : null}
      {show('flags') ? (
        <td>
          <div className="testing-flags">
            {row.flags.map((flag) => (
              <StatusBadge key={flag} tone={FLAG_TONE[flag]}>
                {flag === 'overdue' && row.daysOverdue
                  ? `Overdue ${row.daysOverdue} d`
                  : CONCRETE_WORKLIST_FLAG_LABEL[flag]}
              </StatusBadge>
            ))}
            {row.flags.length > 0 ? (
              <Link to={`/concrete/specimens/${row.setId}`} aria-label={`Details for ${label}`}>
                Details
              </Link>
            ) : null}
          </div>
        </td>
      ) : null}
      <td className="testing-status">
        <StatusBadge tone={tone}>{statusText}</StatusBadge>
        {status === 'saved' && row.result ? (
          <span className="testing-sub">
            entered {timeFormat.format(new Date(row.result.enteredAt))}
          </span>
        ) : null}
        {state.message ? <span className="testing-message">{state.message}</span> : null}
        {reason ? (
          <input
            type="text"
            className="testing-reason"
            aria-label={`Correction reason ${label}`}
            placeholder="Reason for the correction"
            value={edit.reason}
            data-nav-row={index}
            data-nav-field="reason"
            autoComplete="off"
            onChange={(event) => onChange(row.specimenId, 'reason', event.target.value)}
            onKeyDown={(event) => onKey(event, index, 'reason')}
          />
        ) : null}
        {status === 'failed' && canEnter ? (
          <button
            type="button"
            className="testing-retry"
            aria-label={`Retry ${label}`}
            onClick={() => onRetry(row.specimenId)}
          >
            Retry
          </button>
        ) : null}
      </td>
    </tr>
  );
}
