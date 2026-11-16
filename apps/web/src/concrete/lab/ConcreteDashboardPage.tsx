import type {
  ConcreteReceivingQueue,
  ConcreteReviewQueue,
  ConcreteWorklist,
  StageKey,
} from '@materialmule/shared';
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  FilePlus,
  Lock,
  RotateCw,
  Search,
  Table2,
} from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { STAGE_MARK_BG } from '@/components/strata/stage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { StrengthReportList } from '../../concrete-review/StrengthReportList';
import { FEATURES } from '../../features';
import { usePageTitle } from '../../layout/page-title';
import { useOptionalCommandMenu } from '../../search/command-menu';
import {
  readReceivingCounts,
  readReviewCounts,
  readWorklistCounts,
  type SourceLoad,
} from './overview-counts';

type Source = 'receiving' | 'worklist' | 'review';

interface Counter {
  key: string;
  label: string;
  source: Source;
  /** The list that clears this count; null when that list isn't turned on here. */
  to: string | null;
  /** Stage of the stripe while the count is above zero. */
  stage: StageKey;
  /** The tile's second line ("Breaks · Today"). */
  where: string;
}

/** Each counter opens the list that clears it (DESIGN.md round 7, Concrete overview). */
const COUNTERS: readonly Counter[] = [
  {
    key: 'awaitingPickup',
    label: 'Awaiting pickup',
    source: 'receiving',
    to: '/concrete/receiving?stage=awaiting_pickup',
    stage: 'due',
    where: 'Receiving',
  },
  {
    key: 'awaitingReceiving',
    label: 'Awaiting receiving',
    source: 'receiving',
    to: '/concrete/receiving?stage=awaiting_receiving',
    stage: 'draft',
    where: 'Receiving',
  },
  {
    key: 'testsToday',
    label: 'Tests due today',
    source: 'worklist',
    to: FEATURES.labTesting ? '/lab-testing/concrete' : null,
    stage: 'lab',
    where: 'Breaks · Today',
  },
  {
    key: 'testsOverdue',
    label: 'Tests overdue',
    source: 'worklist',
    to: FEATURES.labTesting ? '/lab-testing/concrete?view=overdue' : null,
    stage: 'danger',
    where: 'Breaks · Overdue',
  },
  {
    key: 'onHold',
    label: 'On HOLD',
    source: 'worklist',
    to: FEATURES.labTesting ? '/lab-testing/concrete/holds' : null,
    stage: 'danger',
    where: 'Holds',
  },
  {
    key: 'exceptions',
    label: 'Exceptions',
    source: 'worklist',
    to: FEATURES.labTesting ? '/lab-testing/concrete?view=exceptions' : null,
    stage: 'danger',
    where: 'From the sources checked so far',
  },
  {
    key: 'awaitingReview',
    label: 'Awaiting review',
    source: 'review',
    to: '/concrete/review',
    stage: 'due',
    where: 'Review queue',
  },
  {
    key: 'awaitingIssue',
    label: 'Awaiting issuance',
    source: 'review',
    to: '/concrete/review?status=reviewed_awaiting_issue',
    stage: 'due',
    where: 'Review queue · reviewed',
  },
];

interface Loads {
  receiving: SourceLoad<ConcreteReceivingQueue>;
  worklist: SourceLoad<ConcreteWorklist>;
  review: SourceLoad<ConcreteReviewQueue>;
}

const LOADING: Loads = {
  receiving: { state: 'loading' },
  worklist: { state: 'loading' },
  review: { state: 'loading' },
};

/** A counter's value, or why there is none (never a 0 that wasn't read). */
type Value =
  | { kind: 'count'; count: number; note?: string }
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'off' }
  | { kind: 'failed' };

function valueOf(counter: Counter, loads: Loads): Value {
  const load = loads[counter.source];
  if (load.state !== 'ready') return { kind: load.state === 'loading' ? 'loading' : load.state };
  const count = (n: number | undefined, note?: string): Value => ({
    kind: 'count',
    count: n ?? 0,
    note,
  });
  if (loads.receiving.state === 'ready' && counter.source === 'receiving') {
    const counts = loads.receiving.data.counts;
    return count(
      counter.key === 'awaitingPickup' ? counts.awaiting_pickup : counts.awaiting_receiving,
    );
  }
  if (loads.worklist.state === 'ready' && counter.source === 'worklist') {
    const list = loads.worklist.data;
    if (counter.key === 'testsToday') return count(list.counts.today);
    if (counter.key === 'testsOverdue') return count(list.counts.overdue);
    if (counter.key === 'onHold') {
      return count(
        list.counts.hold,
        list.holdReviewDue > 0 ? `${list.holdReviewDue} past their hold date` : undefined,
      );
    }
    return count(list.counts.exceptions);
  }
  if (loads.review.state === 'ready' && counter.source === 'review') {
    const counts = loads.review.data.counts;
    return count(
      counter.key === 'awaitingReview' ? counts.awaiting_review : counts.reviewed_awaiting_issue,
    );
  }
  return { kind: 'failed' };
}

const UNAVAILABLE: Record<Exclude<Value['kind'], 'count' | 'loading'>, string> = {
  failed: 'Couldn’t load',
  forbidden: 'Not available to you',
  off: 'Not turned on here',
};

/**
 * Concrete → Overview (`/concrete`, STRATA-93; MM-V2-C31's dashboard restyled): eight counters,
 * each a link to the list that clears it, read from those lists. A count that failed or that the
 * account can't see says so instead of reading 0. Then "Find concrete records" (the Ctrl K
 * search) and the strength reports for the lab, under the open G2 gate.
 */
export function ConcreteDashboardPage() {
  usePageTitle('Overview');
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ attempt: number; loads: Loads } | null>(null);
  const loads = answer?.attempt === attempt ? answer.loads : LOADING;
  const newReportHint = useId();

  useEffect(() => {
    let current = true;
    const review = FEATURES.concreteReview
      ? readReviewCounts()
      : Promise.resolve({ state: 'off' } as const);
    void Promise.all([readReceivingCounts(), readWorklistCounts(), review]).then(
      ([receiving, worklist, reviewLoad]) => {
        if (current) setAnswer({ attempt, loads: { receiving, worklist, review: reviewLoad } });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const loading = answer?.attempt !== attempt;
  const values = COUNTERS.map((counter) => ({ counter, value: valueOf(counter, loads) }));
  const failed = values.filter((v) => v.value.kind === 'failed');
  const clear =
    !loading &&
    values.every((v) => v.value.kind === 'count') &&
    values.every((v) => v.value.kind === 'count' && v.value.count === 0);
  const labDay = loads.worklist.state === 'ready' ? loads.worklist.data.today : null;

  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Concrete</h1>
          <p className="text-sm text-muted-foreground">
            {labDay ? (
              <>
                Lab day <span className="font-mono whitespace-nowrap">{labDay}</span> · every
                concrete project
              </>
            ) : (
              'Every concrete project'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button asChild variant="outline">
            <Link to="/concrete/testing">
              <Table2 aria-hidden="true" />
              Open testing table
            </Link>
          </Button>
          <div className="flex max-w-60 flex-col gap-1">
            <Button variant="outline" disabled aria-describedby={newReportHint}>
              <FilePlus aria-hidden="true" />
              New field report
            </Button>
            <p id={newReportHint} className="text-[13px] text-muted-foreground">
              Not built yet: the field form comes with offline field entry (a gate).
            </p>
          </div>
        </div>
      </div>

      <section aria-labelledby="concrete-counts" className="flex flex-col gap-3">
        <h2 id="concrete-counts" className="sr-only">
          Concrete lab counts
        </h2>
        {failed.length > 0 ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {failed.length === COUNTERS.length
                ? 'The counts couldn’t be loaded.'
                : failed.length === 1
                  ? 'One count couldn’t be loaded.'
                  : `${failed.length} counts couldn’t be loaded.`}
            </AlertTitle>
            <AlertDescription>
              {failed.length === COUNTERS.length
                ? 'Check the connection and try again.'
                : `${joinLabels(failed.map((f) => f.counter.label))} didn’t answer. The other counts are current.`}
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
        {clear ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck aria-hidden="true" className="size-4 text-stage-storage-fg" />
            Nothing is waiting in the concrete lab today.
          </p>
        ) : null}
        {loading ? (
          <p role="status" className="sr-only">
            Loading the concrete overview…
          </p>
        ) : null}
        <ul
          aria-busy={loading}
          className="grid grid-cols-4 gap-3 @max-[56rem]:grid-cols-2 @max-[28rem]:grid-cols-1"
        >
          {values.map(({ counter, value }) => (
            <li key={counter.key} className="flex">
              <CounterTile counter={counter} value={value} />
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-3 items-start gap-6 @max-[56rem]:grid-cols-1">
        <FindRecords />
        <StrengthReports />
      </div>
    </div>
  );
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

const TILE =
  'relative h-auto w-full flex-col items-stretch justify-start gap-1 overflow-hidden rounded-xl bg-card py-4 pr-4 pl-5 text-left font-normal whitespace-normal shadow-none hover:bg-accent dark:bg-card';

function CounterTile({ counter, value }: { counter: Counter; value: Value }) {
  const shown = value.kind === 'count' ? String(value.count) : value.kind === 'loading' ? '' : '–';
  const active = value.kind === 'count' && value.count > 0;
  const second =
    value.kind === 'count'
      ? value.note
        ? `${counter.where} · ${value.note}`
        : counter.where
      : value.kind === 'loading'
        ? counter.where
        : UNAVAILABLE[value.kind];
  // The link reads the count, the label and the second line in one name.
  const name =
    value.kind === 'loading'
      ? `${counter.label}, loading`
      : value.kind === 'count'
        ? `${value.count} ${counter.label}${value.note ? `, ${value.note}` : ''}`
        : `${counter.label}: ${UNAVAILABLE[value.kind]}`;
  const body = (
    <>
      {active ? (
        <span
          aria-hidden="true"
          className={cn('absolute inset-y-0 left-0 w-1', STAGE_MARK_BG[counter.stage])}
        />
      ) : null}
      <span className="flex items-start justify-between gap-2">
        {value.kind === 'loading' ? (
          <Skeleton className="h-9 w-10" />
        ) : (
          <span
            className={cn(
              'text-[32px] leading-9 font-bold tabular-nums',
              !active && 'text-muted-foreground',
            )}
          >
            {shown}
          </span>
        )}
        {counter.to ? (
          <ArrowRight aria-hidden="true" className="mt-1 size-4 text-muted-foreground" />
        ) : null}
      </span>
      <span className="text-sm font-semibold">{counter.label}</span>
      <span className="text-[13px] text-muted-foreground">{second}</span>
    </>
  );
  if (!counter.to || value.kind === 'off') {
    return (
      <div
        aria-label={name}
        role="group"
        className={cn(TILE, 'inline-flex rounded-xl border hover:bg-card')}
      >
        {body}
      </div>
    );
  }
  return (
    <Button asChild variant="outline" className={TILE}>
      <Link to={counter.to} aria-label={name} data-counter={counter.key}>
        {body}
      </Link>
    </Button>
  );
}

/** "Find concrete records": the shared Ctrl K search, opened with what was typed. */
function FindRecords() {
  const menu = useOptionalCommandMenu();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const headingId = useId();
  const hintId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (menu) menu.open(q || undefined);
    else navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  return (
    <section
      aria-labelledby={headingId}
      className="col-span-2 flex flex-col gap-3 rounded-xl border bg-card p-5 @max-[56rem]:col-span-1"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 id={headingId} className="text-base font-semibold">
          Find concrete records
        </h2>
        <span className="flex items-center gap-1 text-[13px] text-muted-foreground">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd> searches concrete too
        </span>
      </div>
      <form role="search" aria-labelledby={headingId} className="flex gap-2" onSubmit={submit}>
        <InputGroup className="h-11 max-w-[640px] flex-1">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Find concrete records"
            aria-describedby={hintId}
            placeholder="Set, specimen, field report, ticket, mix, technician or casting date"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <Button type="submit" variant="outline" className="h-11">
          Search
        </Button>
      </form>
      <p id={hintId} className="text-[13px] text-muted-foreground">
        Results open under Concrete in the search results, for example{' '}
        <span className="font-mono whitespace-nowrap">26-18</span>,{' '}
        <span className="font-mono whitespace-nowrap">26-18B</span>,{' '}
        <span className="font-mono whitespace-nowrap">TMP-D07-003</span> or{' '}
        <span className="font-mono whitespace-nowrap">2026-10-14</span>.
      </p>
    </section>
  );
}

/**
 * Strength reports, under the open G2 gate: the lab's list as built today (MM-V2-C39: sets with
 * results to submit, a returned report or a new age after an issue), and the review queue.
 */
function StrengthReports() {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-base font-semibold">
          Strength reports
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-stage-due-mark bg-stage-due-bg px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap text-stage-due-fg">
          <Lock aria-hidden="true" className="size-3" />
          Gate G2 · strength report open
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        The strength report’s content, layout and when it’s issued are still to be decided (G2), so
        it isn’t summarised here. Field and strength reports waiting for review are in the Review
        queue; strength reports are marked Provisional.
      </p>
      <p className="text-sm text-muted-foreground">
        Sets with results to submit, a returned report to correct, or a new age after an issue:
      </p>
      <StrengthReportList
        needsLab
        caption="Strength reports for the lab"
        empty="No strength reports need the lab right now."
      />
      {FEATURES.concreteReview ? (
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/concrete/review">
              <ClipboardCheck aria-hidden="true" />
              Open Review queue
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
