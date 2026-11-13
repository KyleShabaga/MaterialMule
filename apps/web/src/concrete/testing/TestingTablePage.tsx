import {
  CONCRETE_STRENGTH_FLAG_LABEL,
  CONCRETE_TESTING_TABLE_COLUMNS,
  CONCRETE_TESTING_TABLE_COLUMN_LABEL,
  CONCRETE_TESTING_TABLE_SELECTION_MAX,
  CONCRETE_TEST_RESULT_DIMENSION_UNITS,
  CONCRETE_TEST_RESULT_LOAD_UNITS,
  CONCRETE_WORKLIST_FLAG_LABEL,
  concreteCalculationMethodLine,
  concreteTestEntryComplete,
  type ConcreteTestingTable,
  type ConcreteTestingTableColumn,
  type ConcreteTestingTableResult,
  type ConcreteTestingTableRow,
  type StageKey,
  type StaffOption,
} from '@materialmule/shared';
import { ArrowLeft, CircleAlert, Columns3, RotateCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { StageStripe } from '@/components/strata/stage-stripe';
import { StageTag } from '@/components/strata/stage-tag';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { listActiveStaff } from '../../api/projects';
import { FEATURES } from '../../features';
import { useMe } from '../../session/context';
import { useRecordingPerson } from '../../session/recording-person';
import { specimenText } from '../worklist/specimen-text';
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

const LOAD_UNIT = CONCRETE_TEST_RESULT_LOAD_UNITS[0];
const DIMENSION_UNIT = CONCRETE_TEST_RESULT_DIMENSION_UNITS[0];

const labelOf = (row: ConcreteTestingTableRow) => specimenText(row.identity, row.letter);

/** The testing table is reached from Breaks (or the Concrete dashboard when Breaks is off). */
const BACK = FEATURES.labTesting
  ? { to: '/lab-testing/concrete', label: 'Back to concrete breaks' }
  : { to: '/concrete', label: 'Back to Concrete' };

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

  const station = useRecordingPerson();
  // STRATA-95: Record breaks from Breaks opens just the ticked specimens (`?specimenIds=`).
  const [params] = useSearchParams();
  const selectionParam = params.get('specimenIds') ?? '';
  const selection = useMemo(
    () =>
      selectionParam
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .slice(0, CONCRETE_TESTING_TABLE_SELECTION_MAX),
    [selectionParam],
  );
  const selecting = selection.length > 0;
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
    void fetchTestingTable({
      includeOverdue,
      projectId: selecting ? null : projectId || null,
      specimenIds: selecting ? selection : null,
    }).then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        setLoad({ state: 'error', message: answer.message });
        return;
      }
      setTable(answer.data);
      // Rows with unsaved, saving, failed or reason-needed edits keep them (and their retry key)
      // across a reload, even while the new view leaves them out (Include overdue off, another
      // project): they show again, as they were, when a later view lists them.
      setRows((previous) => {
        const unsaved = (state: RowState | undefined): state is RowState =>
          state !== undefined && state.status !== 'saved' && state.status !== 'empty';
        const next: Record<string, RowState> = {};
        for (const [specimenId, state] of Object.entries(previous)) {
          if (unsaved(state)) next[specimenId] = state;
        }
        for (const row of answer.data.groups.flatMap((g) => g.rows)) {
          if (!unsaved(next[row.specimenId])) {
            next[row.specimenId] = initialRowState(row, () => crypto.randomUUID());
          }
        }
        rowsRef.current = next;
        return next;
      });
      setLoad({ state: 'ready' });
    });
    return () => {
      current = false;
    };
  }, [includeOverdue, projectId, attempt, selecting, selection]);

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
  // STRATA-125: on a LAB station "Tested by" is the person picked with the station chip.
  const testerId = station.isStation ? (station.person?.id ?? '') : pageTesterId;
  const chosen = staff.find((p) => p.id === pageTesterId);
  const pageTester: { initials: string; displayName: string } | null = station.isStation
    ? station.person
    : chosen?.initials
      ? { initials: chosen.initials, displayName: chosen.displayName }
      : null;

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
      pageTesterId: testerId || null,
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
      const result = tableResultOf(outcome.result, state.row);
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
      const current = outcome.current ? tableResultOf(outcome.current, state.row) : null;
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

  /**
   * Keyboard first: Enter / Shift+Enter and ↓ / ↑ move to the same column in the next / previous
   * row (leaving a row saves it); ← / → move to the previous / next cell of the row when the
   * caret is at the start / end of the text.
   */
  function onCellKey(event: KeyboardEvent<HTMLInputElement>, index: number, field: string) {
    const container = containerRef.current;
    if (!container) return;
    const all = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[data-nav-row][data-nav-field]'),
    );
    const go = (target: HTMLInputElement | undefined) => {
      if (!target) return false;
      target.focus();
      target.select();
      return true;
    };
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const input = event.currentTarget;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd =
        input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if ((event.key === 'ArrowLeft' && !atStart) || (event.key === 'ArrowRight' && !atEnd)) {
        return;
      }
      const inRow = all.filter((other) => Number(other.dataset.navRow) === index);
      const at = inRow.indexOf(input);
      const target = inRow[at + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (go(target)) event.preventDefault();
      return;
    }
    const down = event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey);
    const up = event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey);
    if (!down && !up) return;
    event.preventDefault();
    const step = up ? -1 : 1;
    const want = field === 'reason' ? NAV_FIELDS[0]! : field;
    const target = all.find(
      (input) => Number(input.dataset.navRow) === index + step && input.dataset.navField === want,
    );
    if (!go(target) && event.key === 'Enter') {
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
    () =>
      (table?.groups ?? []).filter(
        (g) => selecting || projectId === '' || g.projectId === projectId,
      ),
    [table, projectId, selecting],
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
    <section
      aria-label="Testing table"
      className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Button asChild variant="link" className="h-auto self-start p-0 text-muted-foreground">
            <Link to={BACK.to}>
              <ArrowLeft aria-hidden="true" />
              {BACK.label}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Testing table</h1>
          {table ? (
            <p className="text-sm text-muted-foreground">
              Lab date <span className="font-mono">{table.today}</span> (America/Edmonton) ·{' '}
              {all.length} {all.length === 1 ? 'specimen' : 'specimens'} listed
            </p>
          ) : null}
        </div>
        <TesterControl
          station={station.isStation}
          person={station.person}
          staff={staff}
          value={pageTesterId}
          onChange={setPageTesterId}
          disabled={!canEnter}
        />
      </div>

      {selecting ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
          <span role="status">
            Showing {selection.length} selected {selection.length === 1 ? 'specimen' : 'specimens'}{' '}
            from Breaks
          </span>
          <span aria-hidden="true">·</span>
          <Button asChild variant="link" className="h-auto p-0">
            <Link to="/concrete/testing">Show all due</Link>
          </Button>
        </div>
      ) : null}

      {!canEnter ? (
        <p className="text-sm text-muted-foreground" role="note">
          You can view this table. Entering results needs a Lab Technician, Lab Manager or the LAB
          station.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {!selecting ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="testing-project" className="text-sm text-muted-foreground">
              Project
            </Label>
            <Select
              value={projectId || ALL_PROJECTS}
              onValueChange={(value) => {
                setLoad({ state: 'loading' });
                setProjectId(value === ALL_PROJECTS ? '' : value);
              }}
            >
              <SelectTrigger id="testing-project" size="sm" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {(table?.projects ?? []).map((project) => (
                  <SelectItem key={project.projectId} value={project.projectId}>
                    {project.projectNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {!selecting ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="testing-overdue"
              checked={includeOverdue}
              onCheckedChange={(checked) => {
                setLoad({ state: 'loading' });
                setIncludeOverdue(checked === true);
              }}
            />
            <Label htmlFor="testing-overdue" className="font-normal">
              Include overdue
            </Label>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id="testing-hide-completed"
            checked={hideCompleted}
            onCheckedChange={(checked) => setHideCompleted(checked === true)}
          />
          <Label htmlFor="testing-hide-completed" className="font-normal">
            Hide completed
          </Label>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 aria-hidden="true" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Show columns</DropdownMenuLabel>
            {CONCRETE_TESTING_TABLE_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={show(column)}
                // Keep the menu open to show or hide several columns.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleColumn(column)}
              >
                {CONCRETE_TESTING_TABLE_COLUMN_LABEL[column]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto text-sm font-semibold tabular-nums" aria-live="polite">
          {table ? `${completed} of ${all.length} completed` : '…'}
        </span>
      </div>

      {load.state === 'loading' && !table ? (
        <div aria-busy="true" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <p role="status" className="sr-only">
            Loading today’s breaks…
          </p>
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-8 w-full" />
          ))}
        </div>
      ) : null}
      {load.state === 'error' ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{load.message}</AlertTitle>
          <AlertDescription>
            Check the connection and try again. Saved results are unchanged.
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                className="text-foreground"
                onClick={() => {
                  setLoad({ state: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden="true" />
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {table && all.length === 0 ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyTitle>
              {selecting
                ? 'None of the selected specimens can be entered here now.'
                : `No breaks ${includeOverdue ? 'due today or overdue' : 'due today'}.`}
            </EmptyTitle>
            {selecting ? (
              <EmptyDescription>
                They may have been tested, put on HOLD or rescheduled since they were picked.
              </EmptyDescription>
            ) : null}
          </EmptyHeader>
        </Empty>
      ) : null}
      {table?.truncated ? (
        <p className="text-sm text-muted-foreground" role="note">
          Showing the first {table.total} rows. Narrow the list (choose a project or turn off
          Include overdue) to see the rest.
        </p>
      ) : null}
      <div ref={containerRef} className="flex flex-col gap-5">
        {groups.map((group) => {
          const states = group.rows
            .map((row) => rows[row.specimenId])
            .filter((s): s is RowState => s !== undefined);
          const shown = states.filter(visible);
          const done = states.filter((s) => s.row.complete).length;
          return (
            <section
              key={group.projectId}
              className="flex min-w-0 flex-col gap-2"
              aria-labelledby={`testing-group-${group.projectId}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 px-1">
                <h2 id={`testing-group-${group.projectId}`} className="text-base font-semibold">
                  <span className="font-mono">{group.projectNumber}</span> · {group.projectName}
                </h2>
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {done}/{states.length} done
                </span>
              </div>
              {shown.length === 0 ? (
                <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                  All completed rows are hidden.
                </p>
              ) : (
                <div className="@container/table overflow-hidden rounded-xl border bg-card">
                  <Table className="table-fixed">
                    <TableCaption className="sr-only">
                      Breaks for {group.projectNumber}
                    </TableCaption>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        {show('project') ? (
                          <TableHead className={cn(HEAD, 'w-[6.5rem]', PROJECT_HIDE)}>
                            Project
                          </TableHead>
                        ) : null}
                        <TableHead className={cn(HEAD, 'w-[7.5rem] pl-5')}>Specimen</TableHead>
                        {show('age') ? (
                          <TableHead className={cn(HEAD, 'w-[5.5rem]')}>
                            <TwoLine top="Age" bottom="assigned / actual" />
                          </TableHead>
                        ) : null}
                        {show('testedOn') ? (
                          <TableHead className={cn(HEAD, 'w-[7.25rem]')}>Test date</TableHead>
                        ) : null}
                        {show('tester') ? (
                          <TableHead className={cn(HEAD, 'w-[4rem]')}>Tested by</TableHead>
                        ) : null}
                        {show('maxLoad') ? (
                          <TableHead className={cn(HEAD, 'w-[5.5rem]')}>
                            <TwoLine top="Max load" bottom={LOAD_UNIT} />
                          </TableHead>
                        ) : null}
                        {show('height') ? (
                          <TableHead className={cn(HEAD, 'w-[6rem]')}>
                            <TwoLine top="Height" bottom={DIMENSION_UNIT} />
                          </TableHead>
                        ) : null}
                        {show('diameter') ? (
                          <TableHead className={cn(HEAD, 'w-[6rem]')}>
                            <TwoLine top="Diameter" bottom={DIMENSION_UNIT} />
                          </TableHead>
                        ) : null}
                        {show('strength') ? (
                          <TableHead
                            className={cn(HEAD, 'w-[5.5rem]')}
                            title="Provisional calculation method P1 until the office worksheet is confirmed"
                          >
                            <TwoLine top="Strength" bottom="MPa" />
                          </TableHead>
                        ) : null}
                        {show('flags') ? <TableHead className={HEAD}>Flags</TableHead> : null}
                        <TableHead className={cn(HEAD, 'w-[9.5rem]')}>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((state) => (
                        <TestingRow
                          key={state.row.specimenId}
                          state={state}
                          index={navIndexOf.get(state.row.specimenId) ?? -1}
                          projectNumber={group.projectNumber}
                          show={show}
                          canEnter={canEnter}
                          today={today}
                          pageTester={pageTester}
                          onChange={onCellChange}
                          onBlur={onRowBlur}
                          onFocus={setActiveRow}
                          onKey={onCellKey}
                          onRetry={(id) => void commit(id)}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
        <p>
          <Kbd>←</Kbd> <Kbd>↑</Kbd> <Kbd>→</Kbd> <Kbd>↓</Kbd> move between cells · <Kbd>Enter</Kbd>{' '}
          save and go down · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> up · a row saves when you leave it.
          Separate several readings with spaces.
        </p>
        <p>A change to a saved value needs a reason and keeps its history.</p>
        <p>
          Strength is calculated later (not yet confirmed). Units are provisional ({LOAD_UNIT},{' '}
          {DIMENSION_UNIT}) until G8.
        </p>
      </div>
    </section>
  );
}

const ALL_PROJECTS = 'all';
const HEAD =
  'h-auto px-2 py-2 align-bottom text-[13px] font-semibold whitespace-normal text-muted-foreground';
const CELL = 'px-2 py-1.5 align-top';
/**
 * At 1024 px with the rail collapsed the table fits whole (Status stays in view): the Project
 * column, already named by the group heading, gives way first.
 */
const PROJECT_HIDE = '@max-[66rem]/table:hidden';

/** A heading with its unit (or detail) on a second line (DESIGN.md › Tables). */
function TwoLine({ top, bottom }: { top: string; bottom: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span>{top}</span> {/* Read as "Height (mm)"; shown as a second line. */}
      <span className="font-normal">
        <span className="sr-only">(</span>
        {bottom}
        <span className="sr-only">)</span>
      </span>
    </span>
  );
}

/**
 * Tested by: on a LAB station the person picked with the station chip (STRATA-125, attribution
 * only); otherwise a choice of active staff with initials, starting as the signed-in person.
 */
function TesterControl({
  station,
  person,
  staff,
  value,
  onChange,
  disabled,
}: {
  station: boolean;
  person: { displayName: string; initials: string } | null;
  staff: StaffOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  if (station) {
    return (
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="text-muted-foreground">Tested by</span>
        <span className="font-semibold" aria-label="Tested by">
          {person ? `${person.displayName} (${person.initials})` : 'No one picked yet'}
        </span>
        <span className="text-[13px] text-muted-foreground">
          The person picked on this station. Change it with the station chip.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="testing-tester" className="text-sm text-muted-foreground">
        Tested by
      </Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id="testing-tester" size="sm" className="min-w-48">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {staff.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.initials} · {option.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const STATUS_STAGE: Record<RowState['status'], StageKey> = {
  empty: 'closed',
  pending: 'due',
  saving: 'lab',
  saved: 'storage',
  failed: 'danger',
  reason: 'danger',
};

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
  pageTester: { initials: string; displayName: string } | null;
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
      <TableCell className={CELL}>
        <Input
          type="text"
          inputMode={field === 'testedOn' ? 'text' : 'decimal'}
          aria-label={`${name} ${label}`}
          value={edit[field]}
          placeholder={placeholder}
          readOnly={!canEnter}
          data-nav-row={index}
          data-nav-field={field}
          autoComplete="off"
          className="h-8 px-2 font-mono text-sm"
          onChange={(event) => onChange(row.specimenId, field, event.target.value)}
          onKeyDown={(event) => onKey(event, index, field)}
        />
      </TableCell>
    ) : null;

  const statusText =
    status === 'saved' && !row.complete ? 'Saved · incomplete' : STATUS_LABEL[status];
  const stage: StageKey = status === 'saved' && !row.complete ? 'due' : STATUS_STAGE[status];

  return (
    <TableRow
      className={cn(
        'testing-row',
        status === 'failed' || status === 'reason' ? 'bg-stage-danger-bg/40' : null,
      )}
      data-specimen={label}
      data-status={status}
      onBlur={(event) => onBlur(row.specimenId, event)}
      onFocus={() => onFocus(row.specimenId)}
    >
      {show('project') ? (
        <TableCell className={cn(CELL, 'font-mono', PROJECT_HIDE)}>{projectNumber}</TableCell>
      ) : null}
      <TableHead
        scope="row"
        className={cn(CELL, 'relative h-auto pl-5 font-mono font-semibold text-foreground')}
        aria-label={label}
      >
        <StageStripe stage={overdue ? 'danger' : 'lab'} />
        <span className="specimen-id">{label}</span>
      </TableHead>
      {show('age') ? (
        <TableCell className={cn(CELL, 'whitespace-normal tabular-nums')}>
          {row.assignedAge} / {row.actualAge} d
          {row.daysOverdue ? (
            <span className="block text-[13px] text-muted-foreground">target {row.targetDate}</span>
          ) : null}
        </TableCell>
      ) : null}
      {cell('testedOn', 'Test date', row.result ? undefined : today)}
      {show('tester') ? (
        <TableCell className={CELL}>
          {row.result?.tester ? (
            <span title={row.result.tester.name}>{row.result.tester.initials}</span>
          ) : pageTester ? (
            <span className="text-muted-foreground" title="Recorded when the row saves">
              {pageTester.initials}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      ) : null}
      {cell('maxLoad', 'Max load')}
      {cell('height', 'Height')}
      {cell('diameter', 'Diameter')}
      {show('strength') ? (
        <StrengthCell result={row.result} complete={row.complete} label={label} />
      ) : null}
      {show('flags') ? (
        <TableCell className={cn(CELL, 'whitespace-normal')}>
          <div className="flex flex-wrap items-center gap-1">
            {row.flags.map((flag) =>
              flag === 'overdue' ? (
                <StageTag
                  key={flag}
                  stage="danger"
                  label={row.daysOverdue ? `Overdue ${row.daysOverdue} d` : 'Overdue'}
                />
              ) : (
                <StageTag key={flag} variant="outline" label={CONCRETE_WORKLIST_FLAG_LABEL[flag]} />
              ),
            )}
            {(row.result?.strengthFlags ?? []).map((flag) => (
              <StageTag key={flag} stage="due" label={CONCRETE_STRENGTH_FLAG_LABEL[flag]} />
            ))}
            {row.result?.excluded ? <StageTag variant="outline" label="Excluded" /> : null}
            {row.flags.length > 0 ? (
              <Link
                className="text-[13px] underline underline-offset-2"
                to={`/concrete/specimens/${row.setId}`}
                aria-label={`Details for ${label}`}
              >
                Details
              </Link>
            ) : null}
          </div>
        </TableCell>
      ) : null}
      <TableCell className={cn(CELL, 'testing-status whitespace-normal')}>
        <span className="flex flex-col items-start gap-1">
          <StageTag stage={stage} label={statusText} />
          {status === 'saved' && row.result ? (
            <span className="text-[13px] text-muted-foreground">
              entered {timeFormat.format(new Date(row.result.enteredAt))}
            </span>
          ) : null}
          {state.message ? (
            <span className="text-[13px] font-medium text-destructive">{state.message}</span>
          ) : null}
          {reason ? (
            <Input
              type="text"
              aria-label={`Correction reason ${label}`}
              placeholder="Reason for the correction"
              value={edit.reason}
              data-nav-row={index}
              data-nav-field="reason"
              autoComplete="off"
              className="h-8 px-2 text-sm"
              onChange={(event) => onChange(row.specimenId, 'reason', event.target.value)}
              onKeyDown={(event) => onKey(event, index, 'reason')}
            />
          ) : null}
          {status === 'failed' && canEnter ? (
            <Button
              variant="outline"
              size="xs"
              aria-label={`Retry ${label}`}
              onClick={() => onRetry(row.specimenId)}
            >
              Retry
            </Button>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * MM-V2-C24: the stored strength of a complete entry (provisional method P1) with its method
 * version; "—" while the entry is incomplete or L/D is below 1.00. Values never change here: the
 * server calculates and stores them with each save.
 */
function StrengthCell({
  result,
  complete,
  label,
}: {
  result: ConcreteTestingTableResult | null;
  complete: boolean;
  label: string;
}) {
  const calc = complete ? (result?.calculation ?? null) : null;
  if (!calc) {
    return (
      <TableCell className={CELL} aria-label={`Strength ${label}: not calculated`}>
        <span className="text-muted-foreground">—</span>
      </TableCell>
    );
  }
  const method = concreteCalculationMethodLine(calc.methodVersion, calc.provisional);
  const text = calc.strength === null ? '—' : calc.strength.toFixed(1);
  return (
    <TableCell
      className={cn(CELL, 'whitespace-normal tabular-nums')}
      aria-label={`Strength ${label}: ${calc.strength === null ? 'none (L/D below 1.00)' : `${text} MPa`}`}
      title={`${method}. Area ${calc.area} mm², L/D ${calc.ldRatio.toFixed(2)}${
        calc.correctionFactor !== null && calc.correctionFactor !== 1
          ? `, correction ${calc.correctionFactor}`
          : ''
      }`}
    >
      <span className={result?.excluded ? 'line-through' : undefined}>{text}</span>
      <span className="block text-[13px] text-muted-foreground">
        {calc.methodVersion}
        {calc.provisional ? ' (provisional)' : ''}
      </span>
    </TableCell>
  );
}
