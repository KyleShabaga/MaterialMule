import {
  CONCRETE_TESTING_TABLE_SELECTION_MAX,
  type ConcreteWorklist,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import { CircleAlert, Hammer, RotateCw, Table2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { notifySuccess } from '@/components/strata/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMediaQuery } from '../../components/useMediaQuery';
import { PHONE_QUERY } from '../../components/useTableView';
import { FEATURES } from '../../features';
import { useRecordingPerson } from '../../session/recording-person';
import { fetchConcreteWorklist } from './api';
import { HoldUntilDialog, RescheduleDialog } from './BreaksDialogs';
import { BreaksGroup, ExceptionsPanel, HoldGroup } from './BreaksTables';
import { holdBlock, rescheduleBlock, selectionSummary, type Picked } from './breaks-model';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; list: ConcreteWorklist };

/** Tab order on the boards (R7Breaks): what is late first. */
const VIEWS: readonly ConcreteWorklistView[] = [
  'overdue',
  'today',
  'upcoming',
  'hold',
  'exceptions',
];

const VIEW_LABEL: Record<ConcreteWorklistView, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Next 7 days',
  hold: 'On HOLD',
  exceptions: 'Exceptions',
};

const EMPTY: Record<Exclude<ConcreteWorklistView, 'exceptions'>, string> = {
  today: 'No concrete specimens are due today.',
  overdue: 'No specimens are overdue.',
  upcoming: 'No specimens are due in the next seven days.',
  hold: 'No specimens are on HOLD.',
};

const ALL_PROJECTS = 'all';

/**
 * Concrete → Breaks (`/lab-testing/concrete`, STRATA-95 variant A; MM-V2-C22's worklist): tabs
 * Overdue, Today, Next 7 days, On HOLD and Exceptions with counts; one row per set with a set
 * checkbox and one per due specimen; the selection bar offers Record breaks (the Testing table
 * for just the selection), Reschedule and Hold until. Unavailable actions stay visible, disabled,
 * with the reason under them. Display only: a target date is never moved by being listed, and
 * nothing on HOLD is tested, released or disposed of automatically.
 */
export function ConcreteWorklistPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('view');
  const view: ConcreteWorklistView = (VIEWS as readonly string[]).includes(asked ?? '')
    ? (asked as ConcreteWorklistView)
    : 'today';
  const holdDue = params.get('holdDue') === 'true';
  const projectId = params.get('project') ?? '';
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${view}|${holdDue}|${projectId}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // Counts and the project list stay visible while the next view loads.
  const [last, setLast] = useState<ConcreteWorklist | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'reschedule' | 'hold' | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const navigate = useNavigate();
  const station = useRecordingPerson();

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
        // A new list starts with nothing ticked: a ticked specimen is always one on screen.
        setSelected(new Set());
      },
    );
    return () => {
      current = false;
    };
  }, [view, holdDue, projectId, page, requestKey]);

  function update(patch: Record<string, string | null>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
    setPage(1);
  }

  const list = load.state === 'ready' ? load.list : null;
  const shown = list ?? last;
  const counts = shown?.counts;
  const projects = shown?.projects ?? [];
  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const noMachine = shown ? !shown.testingMachineRegistered : false;

  const picked: Picked[] = useMemo(() => {
    if (!list) return [];
    return list.groups.flatMap((group) =>
      group.rows.filter((row) => selected.has(row.specimenId)).map((row) => ({ row, group })),
    );
  }, [list, selected]);

  const done = (message: string | null) => {
    setDialog(null);
    if (message) notifySuccess(message);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-4 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Concrete breaks</h1>
          {shown ? (
            <p className="text-sm text-muted-foreground">
              Lab date <span className="font-mono">{shown.today}</span> (America/Edmonton)
            </p>
          ) : null}
        </div>
        {/* The testing table is for the lab computers; on a phone the note below says so. */}
        {FEATURES.concreteLab && !phone ? (
          <Button asChild variant="outline">
            <Link to="/concrete/testing">
              <Table2 aria-hidden="true" />
              Open testing table (all of today)
            </Link>
          </Button>
        ) : null}
      </div>

      {noMachine ? (
        <Alert className="relative overflow-hidden">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-stage-due-mark" />
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>No testing machine is registered (Settings → Equipment).</AlertTitle>
          <AlertDescription>
            Breaks can’t be recorded until a Lab Manager or admin registers one. You can still look
            through what is due.
            <Button asChild variant="link" className="h-auto p-0">
              <Link to="/settings/equipment">Open Settings → Equipment</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={view} onValueChange={(next) => update({ view: next === 'today' ? null : next })}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList
            aria-label="Concrete worklist views"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {VIEWS.map((v) => (
              <TabsTrigger key={v} value={v}>
                {VIEW_LABEL[v]}{' '}
                <span className="text-muted-foreground tabular-nums">
                  {counts ? counts[v] : '…'}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-2">
            <Label htmlFor="breaks-project" className="text-sm text-muted-foreground">
              Project
            </Label>
            <Select
              value={projectId || ALL_PROJECTS}
              onValueChange={(value) => update({ project: value === ALL_PROJECTS ? null : value })}
            >
              <SelectTrigger id="breaks-project" size="sm" className="min-w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.projectNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <TabsContent value={view} className="mt-2 flex min-w-0 flex-col gap-5">
          {view === 'hold' && shown ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Specimens on HOLD aren’t broken from here. Schedule a test or decide disposal in{' '}
                <Link className="underline underline-offset-2" to="/lab-testing/concrete/holds">
                  Holds
                </Link>
                .
              </p>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="breaks-hold-due"
                  checked={holdDue}
                  onCheckedChange={(checked) =>
                    update({ holdDue: checked === true ? 'true' : null })
                  }
                />
                <Label htmlFor="breaks-hold-due" className="font-normal">
                  Only HOLDs due for review ({shown.holdReviewDue})
                </Label>
              </div>
            </div>
          ) : null}
          {load.state === 'loading' ? <BreaksSkeleton /> : null}
          {load.state === 'error' ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>The concrete breaks couldn’t be loaded.</AlertTitle>
              <AlertDescription>
                {load.message}
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-foreground"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    <RotateCw aria-hidden="true" />
                    Try again
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {list && view === 'exceptions' ? <ExceptionsPanel list={list} /> : null}
          {list && view !== 'exceptions' && list.groups.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Hammer aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{EMPTY[view]}</EmptyTitle>
                {view === 'today' && list.counts.upcoming > 0 ? (
                  <EmptyDescription>
                    {list.counts.upcoming}{' '}
                    {list.counts.upcoming === 1 ? 'specimen is' : 'specimens are'} due in the next
                    seven days.
                  </EmptyDescription>
                ) : null}
              </EmptyHeader>
              {view === 'today' && list.counts.upcoming > 0 ? (
                <EmptyContent>
                  <Button variant="outline" onClick={() => update({ view: 'upcoming' })}>
                    Show next 7 days
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : null}
          {list && view === 'hold'
            ? list.groups.map((group) => <HoldGroup key={group.projectId} group={group} />)
            : null}
          {list && view !== 'hold' && view !== 'exceptions'
            ? list.groups.map((group) => (
                <BreaksGroup
                  key={group.projectId}
                  group={group}
                  view={view}
                  selected={selected}
                  onSelectedChange={setSelected}
                />
              ))
            : null}
          {list && list.total > list.pageSize ? (
            <nav className="flex items-center justify-end gap-2" aria-label="Pages">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-sm tabular-nums">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </TabsContent>
      </Tabs>

      {phone ? (
        <p className="text-[13px] text-muted-foreground">
          Break results are entered at the lab computer, on the testing table.
        </p>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        A test date is always the casting date plus the age. Weekend and holiday test dates are
        flagged, never moved. Nothing on HOLD is tested, released or disposed of automatically.
      </p>

      {picked.length > 0 ? (
        <SelectionBar
          picked={picked}
          noMachine={noMachine}
          stationPerson={station.isStation ? station.person : null}
          onRecord={() =>
            navigate(
              `/concrete/testing?specimenIds=${picked.map((p) => p.row.specimenId).join(',')}`,
            )
          }
          onReschedule={() => setDialog('reschedule')}
          onHold={() => setDialog('hold')}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {dialog === 'reschedule' ? (
        <RescheduleDialog picked={picked} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === 'hold' && list ? (
        <HoldUntilDialog
          picked={picked}
          today={list.today}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      ) : null}
    </div>
  );
}

function BreaksSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <p role="status" className="sr-only">
        Loading concrete breaks…
      </p>
      {[0, 1, 2, 3].map((n) => (
        <Skeleton key={n} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * The selection bar: Record breaks, Reschedule and Hold until stay visible; an action that can't
 * be used is disabled with the reason written under the bar.
 */
function SelectionBar({
  picked,
  noMachine,
  stationPerson,
  onRecord,
  onReschedule,
  onHold,
  onClear,
}: {
  picked: Picked[];
  noMachine: boolean;
  stationPerson: { displayName: string; initials: string } | null;
  onRecord: () => void;
  onReschedule: () => void;
  onHold: () => void;
  onClear: () => void;
}) {
  const recordId = useId();
  const rescheduleId = useId();
  const holdId = useId();
  const tooMany = picked.length > CONCRETE_TESTING_TABLE_SELECTION_MAX;
  const recordReason = !FEATURES.concreteLab
    ? 'Record breaks needs the testing table, which isn’t turned on here.'
    : noMachine
      ? 'Record breaks needs a registered testing machine.'
      : tooMany
        ? `Record breaks opens at most ${CONCRETE_TESTING_TABLE_SELECTION_MAX} specimens at once.`
        : null;
  const rescheduleReason = picked.every((p) => !p.group.canReschedule)
    ? 'Reschedule needs the project lead, a designated reviewer or a Lab Manager with the project’s concrete grant.'
    : picked.every((p) => rescheduleBlock(p) !== null)
      ? 'None of the selected specimens can be rescheduled from here.'
      : null;
  const holdReason = picked.every((p) => !p.group.canHoldUntil)
    ? 'Hold until needs the project lead or a Lab Manager.'
    : picked.every((p) => holdBlock(p) !== null)
      ? 'None of the selected specimens can go on HOLD from here.'
      : null;
  const recordHint = recordReason
    ? null
    : `Record breaks opens the testing table with just these ${picked.length} ${
        picked.length === 1 ? 'specimen' : 'specimens'
      }${stationPerson ? `, tested by ${stationPerson.displayName} (${stationPerson.initials})` : ''}.`;

  return (
    <section
      aria-label="Selection"
      className="sticky bottom-4 z-10 flex flex-col gap-1 rounded-xl border bg-popover p-3 shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="mr-2 text-sm font-semibold tabular-nums">
          {selectionSummary(picked)}
        </span>
        <Button
          onClick={onRecord}
          disabled={recordReason !== null}
          aria-describedby={recordReason ? recordId : undefined}
        >
          Record breaks
        </Button>
        <Button
          variant="outline"
          onClick={onReschedule}
          disabled={rescheduleReason !== null}
          aria-describedby={rescheduleReason ? rescheduleId : undefined}
        >
          Reschedule
        </Button>
        <Button
          variant="outline"
          onClick={onHold}
          disabled={holdReason !== null}
          aria-describedby={holdReason ? holdId : undefined}
        >
          Hold until
        </Button>
        <Button variant="ghost" onClick={onClear} className="ml-auto">
          Clear selection
        </Button>
      </div>
      <div className="flex flex-col gap-0.5 text-[13px] text-muted-foreground">
        {recordReason ? <p id={recordId}>{recordReason}</p> : <p>{recordHint}</p>}
        {rescheduleReason ? <p id={rescheduleId}>{rescheduleReason}</p> : null}
        {holdReason ? <p id={holdId}>{holdReason}</p> : null}
      </div>
    </section>
  );
}
