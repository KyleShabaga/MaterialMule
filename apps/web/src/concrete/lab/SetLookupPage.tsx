import {
  CONCRETE_HOLD_AGE,
  concreteLabToday,
  type ConcreteReceivingSpecimen,
  type ConcreteRescheduleEntry,
  type ConcreteSpecimenDetail,
  type ConcreteTestingTableRow,
} from '@materialmule/shared';
import {
  CalendarClock,
  Check,
  Ellipsis,
  Hammer,
  Hourglass,
  Link2,
  PackageCheck,
  SearchX,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
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
import { CONCRETE_SET_STEPS, LifecycleTrack } from '../../components/strata/lifecycle-track';
import { PersonAvatar } from '../../components/strata/person-avatar';
import { StageStripe } from '../../components/strata/stage-stripe';
import { StageTag } from '../../components/strata/stage-tag';
import { notifyError, notifySuccess } from '../../components/strata/toast';
import { usePageTitle } from '../../layout/page-title';
import { useRecordRecent } from '../../layout/record-recent';
import { useOptionalCommandMenu } from '../../search/command-menu';
import { useMe } from '../../session/context';
import {
  fetchScheduleHistory,
  fetchSetLookup,
  fetchSetTesting,
  type LoadResult,
  type SetLookup,
} from './api';
import {
  ageDays,
  fieldReportPath,
  labDate,
  labStamp,
  setLabel,
  specimenName,
  UNCAST_DETAIL,
  UNCAST_NOTE,
} from './format';
import { ReceiveSetSheet } from './ReceiveSetSheet';
import { isDue, setRecordState, type SetRecordState } from './set-record';

// Specimens → one set (STRATA-95 part B, canvas R7Set*): the record pattern. The header holds the
// set's label block (type, project, set ID, field ID, cast, field report) and, beside it, the
// stage tag, the lifecycle track and one main action by state (Receive, Record breaks, Open
// hold); the specimens with their test dates (rescheduled marked) and Cast and pickup sit 2 : 1
// beside a sticky History. Reads only: C05's set, C06's receiving, C04's report, C22's schedule
// history and C23's testing rows for the set's scheduled specimens.

interface HistoryEntry {
  at: string;
  who: string | null;
  text: ReactNode;
}

const HOLDS_PATH = '/lab-testing/concrete/holds';
const breaksPath = (ids: readonly string[]) =>
  `/concrete/testing?specimenIds=${ids.map(encodeURIComponent).join(',')}`;

/** One time-ordered history from the set, receiving and schedule records (newest first). */
function historyOf(
  data: SetLookup,
  name: string,
  reschedules: Map<string, ConcreteRescheduleEntry[]>,
): HistoryEntry[] {
  const { set, receiving } = data;
  const letterOf = new Map(set.specimens.map((s) => [s.id, s.letter]));
  const ids = (list: readonly string[]) =>
    list
      .map((id) => letterOf.get(id))
      .filter(Boolean)
      .map((l) => specimenName(name, l!))
      .join(', ');
  const mono = (text: string) => <span className="font-mono whitespace-nowrap">{text}</span>;
  const entries: HistoryEntry[] = [
    { at: set.createdAt, who: set.createdBy?.name ?? null, text: 'recorded the set' },
  ];
  if (set.castAt) {
    entries.push({ at: set.castAt, who: set.technician?.name ?? null, text: 'cast the set' });
  }
  for (const sp of receiving.specimens) {
    const id = specimenName(name, sp.letter);
    const p = sp.pickup;
    if (p?.completed && p.collectedAt) {
      entries.push({
        at: p.collectedAt,
        who: p.collectedBy?.name ?? null,
        text: (
          <>
            picked up {mono(id)}, curing {p.curingMinC}–{p.curingMaxC} °C
            {p.curingFlags?.length ? ', out of range' : ''}
          </>
        ),
      });
    }
    if (p?.curingResolution) {
      entries.push({
        at: p.curingResolution.at,
        who: p.curingResolution.by.name,
        text: (
          <>
            resolved the curing flag on {mono(id)}: “{p.curingResolution.note}”
          </>
        ),
      });
    }
    const r = sp.receipt;
    if (r) {
      entries.push({
        at: r.receivedAt,
        who: r.receivedBy.name,
        text: (
          <>
            received {mono(id)}, {r.massG} g
          </>
        ),
      });
      for (const c of r.corrections) {
        entries.push({
          at: c.at,
          who: c.by.name,
          text: (
            <>
              corrected the mass of {mono(id)}, {c.previousMassG} → {c.newMassG} g: “{c.reason}”
            </>
          ),
        });
      }
    }
    for (const x of reschedules.get(sp.specimenId) ?? []) {
      entries.push({
        at: x.at,
        who: x.by.name,
        text: (
          <>
            rescheduled {mono(id)} from {x.previousAge}-day to {x.newAge}-day: “{x.reason}”
          </>
        ),
      });
    }
  }
  for (const m of receiving.markerConfirmations) {
    entries.push({
      at: m.confirmedAt,
      who: m.confirmedBy.name,
      text: <>confirmed permanent IDs on {mono(ids(m.specimenIds))}</>,
    });
  }
  for (const e of receiving.exceptions) {
    const which = e.specimenId ? ` ${specimenName(name, letterOf.get(e.specimenId) ?? '')}` : '';
    entries.push({
      at: e.createdAt,
      who: e.reportedBy.name,
      text: `reported a ${e.kind} specimen${which}${e.note ? `: “${e.note}”` : ''}`,
    });
    if (e.resolution) {
      entries.push({
        at: e.resolution.at,
        who: e.resolution.by.name,
        text: `resolved the ${e.kind} specimen${which}: ${e.resolution.disposition}`,
      });
    }
  }
  if (set.void) {
    entries.push({ at: set.void.voidedAt, who: null, text: `Set made Void: ${set.void.reason}` });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function receivingCell(r: ConcreteReceivingSpecimen | undefined): ReactNode {
  if (!r) return <span className="text-muted-foreground">—</span>;
  if (r.receipt) {
    return (
      <>
        <span className="text-[13px] whitespace-nowrap">
          Received {labDate(r.receipt.receivedAt)}
        </span>
        <span className="block font-mono text-[12px] text-muted-foreground">
          {r.receipt.massG} g
        </span>
      </>
    );
  }
  if (r.state === 'missing_resolved') return 'Missing (resolved)';
  if (r.state === 'picked_up') {
    return (
      <span className="text-[13px]">
        Picked up{r.pickup?.collectedAt ? ` ${labDate(r.pickup.collectedAt)}` : ''} · not received
      </span>
    );
  }
  return <span className="text-[13px]">Awaiting pickup</span>;
}

function resultCell(
  s: ConcreteSpecimenDetail,
  row: ConcreteTestingTableRow | undefined,
  today: string,
  holdEnded: boolean,
): ReactNode {
  if (s.assignedAge === CONCRETE_HOLD_AGE) {
    return holdEnded ? (
      <StageTag stage="danger" label="Hold period has ended" />
    ) : (
      <StageTag variant="neutral" icon={Hourglass} label="On HOLD" />
    );
  }
  if (row?.complete && row.result) {
    return (
      <>
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-stage-storage-fg">
          <Check aria-hidden="true" className="size-3.5" />
          Entered {row.result.testedOn ?? labDate(row.result.enteredAt)}
        </span>
        {row.result.tester ? (
          <span className="block text-[12px] text-muted-foreground">{row.result.tester.name}</span>
        ) : null}
      </>
    );
  }
  if (!s.targetDate) return <span className="text-[13px] text-muted-foreground">No test date</span>;
  if (isDue(s, new Map(row ? [[s.id, row]] : []), today)) {
    return s.targetDate < today ? (
      <StageTag stage="danger" label="Overdue" />
    ) : (
      <StageTag stage="lab" label="Due today" />
    );
  }
  return <span className="text-[13px] text-muted-foreground">Not tested</span>;
}

function LoadingState({ name }: { name: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <Skeleton className="h-4 w-40" />
      <div className="grid gap-6 @min-[52rem]:grid-cols-[minmax(0,24rem)_1fr]">
        <Card className="gap-3 p-5 shadow-none">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-60" />
        </Card>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-36 rounded-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-11 w-36" />
        </div>
      </div>
      <Card className="gap-3 p-5 shadow-none">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </Card>
      <p className="sr-only" role="status">
        Loading set {name}
      </p>
    </div>
  );
}

function Crumbs({ current }: { current?: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {current ? (
            <BreadcrumbLink asChild>
              <Link to="/concrete/specimens">Specimens</Link>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>Specimens</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {current ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono whitespace-nowrap">{current}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

interface Loaded {
  key: string;
  load: LoadResult<SetLookup>;
  reschedules: Map<string, ConcreteRescheduleEntry[]>;
  testing: Map<string, ConcreteTestingTableRow>;
}

/** The set page: the record pattern for a specimen set. */
export function SetLookupPage() {
  const { setId = '' } = useParams();
  const [params] = useSearchParams();
  const letter = params.get('letter');
  const me = useMe();
  const commandMenu = useOptionalCommandMenu();
  const [attempt, setAttempt] = useState(0);
  const [receiving, setReceiving] = useState(false);
  const key = `${setId}|${attempt}`;
  const [answer, setAnswer] = useState<Loaded | null>(null);
  const ready = answer?.key === key ? answer : null;
  const load = ready?.load ?? null;

  useEffect(() => {
    let current = true;
    void fetchSetLookup(setId).then(async (result) => {
      if (!current) return;
      setAnswer({ key, load: result, reschedules: new Map(), testing: new Map() });
      if (!result.ok) return;
      const scheduled = result.data.set.specimens
        .filter((s) => s.assignedAge !== CONCRETE_HOLD_AGE && s.targetDate)
        .map((s) => s.id);
      const [histories, testing] = await Promise.all([
        Promise.all(result.data.set.specimens.map((s) => fetchScheduleHistory(s.id))),
        scheduled.length > 0 ? fetchSetTesting(scheduled) : Promise.resolve(null),
      ]);
      if (!current) return;
      setAnswer({
        key,
        load: result,
        reschedules: new Map(
          histories.flatMap((h) => (h.ok ? [[h.data.specimenId, h.data.history] as const] : [])),
        ),
        testing: new Map(
          testing?.ok
            ? testing.data.groups.flatMap((g) => g.rows.map((r) => [r.specimenId, r] as const))
            : [],
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [setId, key]);

  const name = load?.ok ? setLabel(load.data.set.identity) : null;
  useRecordRecent('specimen_set', load?.ok ? load.data.set.id : null);
  usePageTitle(name);

  const frame = (children: ReactNode) => (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-6">
      {children}
    </div>
  );

  if (load === null) return frame(<LoadingState name={letter ?? 'set'} />);
  if (!load.ok) {
    return frame(
      <>
        <Crumbs />
        <h1 className="sr-only">Specimens</h1>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {load.notFound ? 'No set or specimen has this ID.' : load.message}
            </EmptyTitle>
            <EmptyDescription>
              {load.notFound
                ? 'Check the marking on the specimen, or search by field report, ticket or casting date.'
                : 'Check the connection and try again.'}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            {load.notFound ? (
              <Button asChild variant="outline">
                <Link to="/concrete/specimens">Look up another set</Link>
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            )}
            {commandMenu ? (
              <Button variant="outline" onClick={() => commandMenu.open()}>
                Search all concrete
              </Button>
            ) : null}
          </EmptyContent>
        </Empty>
      </>,
    );
  }

  const { set, receiving: rec, report } = load.data;
  const today = concreteLabToday();
  const testing = ready!.testing;
  const reschedules = ready!.reschedules;
  const state: SetRecordState = setRecordState({ set, receiving: rec, testing, today });
  const recOf = new Map(rec.specimens.map((s) => [s.specimenId, s]));
  const setName = name!;
  const history = historyOf(load.data, setName, reschedules);
  const canReceive = me.permissions.includes('concrete_specimen.receive');
  const scheduledIds = set.specimens
    .filter((s) => s.assignedAge !== CONCRETE_HOLD_AGE && s.targetDate)
    .map((s) => s.id);
  const type = `${set.mouldSize ? `${set.mouldSize} ` : ''}${set.specimenType}`;
  const technician = set.technician?.name ?? report.technician?.name ?? null;
  const first = set.specimens[0]?.letter;
  const lastLetter = set.specimens[set.specimens.length - 1]?.letter;
  const endedNames = state.holdEnded
    .map((id) => set.specimens.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => specimenName(setName, s!.letter));

  let main: ReactNode = null;
  if (state.main?.kind === 'receive' && canReceive) {
    main = (
      <Button type="button" onClick={() => setReceiving(true)}>
        <PackageCheck aria-hidden="true" />
        Receive
      </Button>
    );
  } else if (state.main?.kind === 'breaks') {
    main = (
      <Button asChild>
        <Link to={breaksPath(state.main.specimenIds)}>
          <Hammer aria-hidden="true" />
          Record breaks
        </Link>
      </Button>
    );
  } else if (state.main?.kind === 'hold') {
    main = (
      <Button asChild variant={state.key === 'hold_ended' ? 'default' : 'outline'}>
        <Link to={HOLDS_PATH}>
          <Hourglass aria-hidden="true" />
          Open hold
        </Link>
      </Button>
    );
  }

  const facts: [string, ReactNode][] = [
    ...(set.identity.permanentId && set.identity.temporaryId
      ? ([['Temporary ID', <span className="font-mono">{set.identity.temporaryId}</span>]] as [
          string,
          ReactNode,
        ][])
      : []),
    ...(report.fields.paperFieldId
      ? ([['Field ID', <span className="font-mono">{report.fields.paperFieldId}</span>]] as [
          string,
          ReactNode,
        ][])
      : []),
    [
      'Cast',
      set.castAt ? (
        <span className="font-mono whitespace-nowrap">{labStamp(set.castAt)}</span>
      ) : (
        <span>
          {UNCAST_NOTE} · <span className="text-muted-foreground">{UNCAST_DETAIL}</span>
        </span>
      ),
    ],
    [
      'Field report',
      <Button variant="link" asChild className="h-auto p-0">
        <Link to={fieldReportPath(report.id)}>
          Field report
          {report.fields.reportDate ? (
            <>
              {' '}
              <span className="font-mono whitespace-nowrap">{report.fields.reportDate}</span>
            </>
          ) : null}
          {technician ? ` · ${technician}` : ''}
        </Link>
      </Button>,
    ],
  ];

  const ages = set.defaultSchedule
    ? `${set.defaultSchedule.ages.map((a) => (a === CONCRETE_HOLD_AGE ? 'HOLD' : a)).join(' / ')} · HOLD ${set.defaultSchedule.holdDurationDays} days`
    : null;
  const pickups = rec.specimens.filter((s) => s.pickup?.completed);
  const pickup = pickups[0]?.pickup ?? null;
  const castFacts: [string, ReactNode][] = [
    [
      'Mix',
      report.fields.mixNumber ? <span className="font-mono">{report.fields.mixNumber}</span> : null,
    ],
    ['Saved schedule', ages ? <span className="font-mono">{ages}</span> : null],
    [
      'Pickup',
      pickup
        ? `${pickups.length < rec.specimens.length ? `${pickups.length} of ${rec.specimens.length} picked up by ` : ''}${pickup.collectedBy?.name ?? 'someone'}, ${pickup.collectedAt ? labStamp(pickup.collectedAt) : ''}`
        : 'Not recorded yet',
    ],
    [
      'Initial curing',
      pickup?.curingMinC && pickup.curingMaxC ? (
        <span className="font-mono">
          {pickup.curingMinC}–{pickup.curingMaxC} °C{' '}
          <span className="font-sans text-[13px] text-muted-foreground">
            ·{' '}
            {pickup.curingRange
              ? pickup.curingFlags?.length
                ? 'out of range, flagged for review'
                : `within ${pickup.curingRange.specification}`
              : 'no curing range set yet, not checked'}
          </span>
        </span>
      ) : null,
    ],
  ];

  return frame(
    <>
      <Crumbs current={setName} />
      <header className="grid items-stretch gap-6 @min-[52rem]:grid-cols-[minmax(0,24rem)_1fr]">
        <Card className="relative gap-0 overflow-hidden py-4 pr-5 pl-6 shadow-none">
          <StageStripe stage={'stage' in state.tag ? state.tag.stage : 'closed'} variant="edge" />
          <p className="text-[13px] text-muted-foreground">
            {type} ·{' '}
            <Button variant="link" asChild className="h-auto p-0 font-mono text-[13px]">
              <Link to={`/projects/${report.projectId}`}>{report.projectNumber}</Link>
            </Button>{' '}
            {report.projectName}
          </p>
          <h1 className="mt-1 font-mono text-[28px] leading-[34px] font-bold whitespace-nowrap">
            {setName}
          </h1>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {facts.map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-muted-foreground">{term}</dt>
                <dd className="min-w-0">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <div className="flex min-w-0 flex-col justify-center gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {'stage' in state.tag ? (
              <StageTag stage={state.tag.stage} label={state.tag.label} />
            ) : (
              <StageTag variant="neutral" icon={Hourglass} label={state.tag.label} />
            )}
            {state.key === 'awaiting' ? (
              <span className="text-[13px] text-muted-foreground">
                {state.received} of {state.expected} received
              </span>
            ) : null}
          </div>
          <LifecycleTrack
            steps={CONCRETE_SET_STEPS}
            current={state.step}
            label={`Lifecycle of set ${setName}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            {main}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon" aria-label="More actions">
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {scheduledIds.length > 0 ? (
                  <DropdownMenuItem asChild>
                    <Link to={breaksPath(scheduledIds)}>
                      <Table2 aria-hidden="true" />
                      Open in testing table
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link to="/lab-testing/concrete">
                    <CalendarClock aria-hidden="true" />
                    Open Breaks
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const url = `${window.location.origin}/concrete/specimens/${set.id}`;
                    navigator.clipboard?.writeText(url).then(
                      () => notifySuccess('Link copied'),
                      () => notifyError('Couldn’t copy the link.'),
                    );
                  }}
                >
                  <Link2 aria-hidden="true" />
                  Copy link
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {state.key === 'hold_ended' ? (
        <Alert className="overflow-hidden pl-5">
          <StageStripe stage="danger" variant="edge" />
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <span>
              <span className="font-mono">{endedNames.join(', ')}</span>{' '}
              {endedNames.length === 1 ? 'passed its' : 'passed their'} hold date. Nothing is
              tested, released or disposed of until someone decides in Holds.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 @min-[56rem]:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 @min-[56rem]:col-span-2">
          <section
            aria-label="Specimens"
            className="flex flex-col gap-3 overflow-hidden rounded-xl border bg-card pt-5"
          >
            <div className="flex items-baseline justify-between gap-4 px-5">
              <h2 className="text-base font-semibold">Specimens</h2>
              <span className="text-[13px] text-muted-foreground">
                {set.specimens.length} {set.specimens.length === 1 ? 'specimen' : 'specimens'}
                {first && lastLetter && first !== lastLetter
                  ? ` · lettered ${first}–${lastLetter}`
                  : ''}
              </span>
            </div>
            <Table className="text-sm">
              <TableCaption className="sr-only">Specimens in {setName}</TableCaption>
              <TableHeader className="bg-muted">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10 pl-5 text-[13px] font-semibold">Specimen</TableHead>
                  <TableHead className="h-10 text-[13px] font-semibold">Age</TableHead>
                  <TableHead className="h-10 text-[13px] font-semibold">Test date</TableHead>
                  <TableHead className="h-10 text-[13px] font-semibold">Receiving</TableHead>
                  <TableHead className="h-10 pr-5 text-[13px] font-semibold">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {set.specimens.map((s) => {
                  const moved = reschedules.get(s.id) ?? [];
                  const was = moved[0]?.previousAge;
                  const id = specimenName(setName, s.letter);
                  return (
                    <TableRow key={s.id} className="h-[52px]">
                      <TableCell className="pl-5">
                        <span className="font-mono font-semibold whitespace-nowrap">{id}</span>
                        {s.letter === letter ? (
                          <Badge variant="outline" className="ml-2">
                            Searched
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono whitespace-nowrap">
                          {ageDays(s.assignedAge)}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {s.assignedAge === CONCRETE_HOLD_AGE ? (
                          s.holdExpiresOn ? (
                            <>
                              <span className="text-[13px]">Hold until</span>
                              <span className="block font-mono">{s.holdExpiresOn}</span>
                            </>
                          ) : (
                            <span className="text-[13px] text-muted-foreground">
                              {set.castAt ? 'No expiry' : 'Set when the casting time is recorded'}
                            </span>
                          )
                        ) : s.targetDate ? (
                          <>
                            <span className="font-mono whitespace-nowrap">{s.targetDate}</span>
                            {was !== undefined ? (
                              <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
                                <CalendarClock aria-hidden="true" className="size-3" />
                                Rescheduled · was {was}-day
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">
                            {set.castAt ? '—' : 'Set when the casting time is recorded'}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {receivingCell(recOf.get(s.id))}
                      </TableCell>
                      <TableCell className="pr-5 whitespace-normal">
                        {resultCell(s, testing.get(s.id), today, state.holdEnded.includes(s.id))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>

          <section
            aria-labelledby="set-cast"
            className="flex flex-col gap-3 rounded-xl border bg-card p-5"
          >
            <h2 id="set-cast" className="text-base font-semibold">
              Cast and pickup
            </h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              {castFacts
                .filter(([, value]) => value)
                .map(([term, value]) => (
                  <div key={term} className="contents">
                    <dt className="text-muted-foreground">{term}</dt>
                    <dd className="min-w-0">{value}</dd>
                  </div>
                ))}
            </dl>
          </section>
        </div>

        <aside
          aria-labelledby="set-history"
          className="flex flex-col gap-4 rounded-xl border bg-card p-5 @min-[56rem]:sticky @min-[56rem]:top-6"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="set-history" className="text-base font-semibold">
              History
            </h2>
            <span className="text-[13px] text-muted-foreground">
              {history.length} {history.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          <ItemGroup aria-label="History, newest first" className="gap-0">
            {history.map((entry, i) => (
              <Item key={`${entry.at}-${i}`} size="sm" className="items-start px-0 py-2">
                <ItemMedia>
                  <PersonAvatar name={entry.who} system={entry.who === null} />
                </ItemMedia>
                <ItemContent className="gap-0.5">
                  <ItemTitle className="line-clamp-none block font-normal">
                    {entry.who ? <span className="font-medium">{entry.who}</span> : null}{' '}
                    {entry.text}
                  </ItemTitle>
                  <ItemDescription className="font-mono text-[13px]">
                    <time dateTime={entry.at}>{labStamp(entry.at)}</time>
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </aside>
      </div>

      <ReceiveSetSheet
        setId={receiving ? set.id : null}
        mode="receive"
        scannedLetter={letter}
        onClose={() => setReceiving(false)}
        onDone={(message) => {
          setReceiving(false);
          notifySuccess(message);
          setAttempt((n) => n + 1);
        }}
      />
    </>,
  );
}
