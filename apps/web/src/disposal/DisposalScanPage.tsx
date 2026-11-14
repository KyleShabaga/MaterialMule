import { ROLE_LABELS, type DisposalReady, type StageKey } from '@materialmule/shared';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Circle,
  Clock,
  CloudOff,
  Copy,
  LoaderCircle,
  MapPin,
  PackageX,
  RotateCw,
  ScanLine,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BulkConfirmDialog } from '@/components/strata/bulk-confirm-dialog';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { StageStripe } from '@/components/strata/stage-stripe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { useOnline } from '../lib/online';
import { ScanField } from '../scanning/ScanField';
import { useScanner } from '../scanning/useScanner';
import { useMe } from '../session/context';
import { fetchApprovedWaiting } from './scan-api';
import { useDisposalScanSession, type ScanProblem } from './scan-session';
import { indexedDbScanStore, type CachedApproved, type QueuedScan } from './scan-store';

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: 'numeric',
  minute: '2-digit',
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface RowView {
  stage: StageKey;
  icon: LucideIcon;
  text: string;
  tone: 'ok' | 'flag' | 'muted';
}

/** What one scan's row says, from what the server last answered (never guessed). */
function rowView(scan: QueuedScan, online: boolean, cached: Map<string, CachedApproved>): RowView {
  if (scan.state === 'done' && scan.outcome) {
    return scan.outcome.result === 'disposed'
      ? { stage: 'closed', icon: Check, text: 'Disposed', tone: 'muted' }
      : { stage: 'danger', icon: CircleAlert, text: scan.outcome.message, tone: 'flag' };
  }
  if (scan.state === 'uncertain') {
    return {
      stage: 'due',
      icon: Clock,
      text: 'Recording sent, no answer yet. Not disposed until Material Mule confirms it.',
      tone: 'muted',
    };
  }
  if (scan.state === 'checked' && scan.check) {
    return scan.check.status === 'approved'
      ? { stage: 'storage', icon: CircleCheck, text: 'Approved · will be disposed', tone: 'ok' }
      : { stage: 'danger', icon: CircleAlert, text: scan.check.message, tone: 'flag' };
  }
  if (online) return { stage: 'closed', icon: LoaderCircle, text: 'Checking…', tone: 'muted' };
  return cached.has(scan.code)
    ? {
        stage: 'closed',
        icon: Clock,
        text: 'Not disposed yet · approved when last checked; needs online check',
        tone: 'muted',
      }
    : {
        stage: 'closed',
        icon: CloudOff,
        text: 'Not disposed yet · needs online check: this computer hasn’t seen this unit',
        tone: 'muted',
      };
}

function unitLine(scan: QueuedScan, cached: Map<string, CachedApproved>) {
  const unit = scan.check?.unit;
  if (unit) {
    return (
      <>
        <span className="font-mono">{unit.projectNumber}</span>
        {unit.holes.map((hole) => (
          <span key={hole}>
            {' · '}
            <span className="font-mono">{hole}</span>
          </span>
        ))}
        {' · from '}
        <span className="font-mono">{unit.location.code}</span>
      </>
    );
  }
  const seen = cached.get(scan.code);
  if (seen) {
    return (
      <>
        <span className="font-mono">{seen.projectNumber}</span>
        {' · from '}
        <span className="font-mono">{seen.location.code}</span>
      </>
    );
  }
  return 'Typed or scanned ID';
}

const isFlagged = (scan: QueuedScan) =>
  (scan.state === 'checked' && scan.check?.status !== 'approved') ||
  (scan.state === 'done' && scan.outcome?.result !== 'disposed');

const isApproved = (scan: QueuedScan) =>
  scan.state === 'checked' && scan.check?.status === 'approved';

function problemText(problem: ScanProblem): { title: string; body: string } {
  switch (problem.kind) {
    case 'signin':
      return {
        title: 'Sign in again to check these scans',
        body: 'Your session ended. The scans stay on this computer and are checked again after you sign in. Nothing was disposed.',
      };
    case 'forbidden':
      return {
        title: 'This sign-in can’t record disposal',
        body: 'Disposal scans need a personal sign-in with disposal scanning. Nothing was disposed.',
      };
    case 'unavailable':
      return {
        title: 'Material Mule didn’t answer',
        body: 'The scans stay on this computer as they are. Nothing is shown as disposed until Material Mule answers.',
      };
    case 'invalid':
      return { title: 'These scans couldn’t be read', body: problem.message };
    case 'storage':
      return { title: 'Scans can’t be kept on this computer', body: problem.message };
  }
}

/**
 * Disposal scan-out (STRATA-92, `/disposal-retention/scan`): the round 3 Move pattern for taking
 * approved units off their shelves. Each scan is an intent stored on this computer first, then
 * checked online (approved, not approved, on hold, open program, unknown…); flagged rows are never
 * disposed. "Record disposal of n units" opens the confirmation that lists every ID and says it
 * can't be undone; only then does the server record, rechecking each unit. Offline, scans queue
 * here as "Not disposed yet" and are checked again when the connection returns; recording still
 * needs the person to confirm the exact list (Kyle's decision STRATA-112, 2026-11-13). Any
 * personal account with disposal scanning may record; a LAB station never (STRATA-111). No Undo.
 */
export function DisposalScanPage() {
  const me = useMe();
  const online = useOnline();
  const allowed =
    me.accountType !== 'shared_lab' && me.permissions.includes('storage_unit.dispose_scan');
  const account = useMemo(() => ({ id: me.id, name: me.displayName }), [me.id, me.displayName]);
  const session = useDisposalScanSession({ account, online, allowed });
  const [repeats, setRepeats] = useState<{ key: string; code: string }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [finished, setFinished] = useState<{ at: string } | null>(null);
  const [ready, setReady] = useState<DisposalReady | null | 'loading'>('loading');
  const [cachedList, setCachedList] = useState<CachedApproved[]>([]);

  // Approved and waiting: from the server online (and kept for offline), else the last copy.
  useEffect(() => {
    let active = true;
    if (online) {
      void fetchApprovedWaiting().then(async (next) => {
        if (!active) return;
        setReady(next);
        if (next) {
          const cachedAt = new Date().toISOString();
          const units = next.units
            .filter((unit) => unit.stage === 'approved')
            .map((unit) => ({
              readableId: unit.readableId,
              projectNumber: unit.project.projectNumber,
              location: unit.location,
              cachedAt,
            }));
          setCachedList(units);
          await indexedDbScanStore.putApproved(units).catch(() => undefined);
        }
      });
    } else {
      void indexedDbScanStore
        .listApproved()
        .then((units) => active && setCachedList(units))
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [online, finished]);

  // Offline, what the server said earlier is not shown as current.
  const shownReady = online ? ready : null;

  const cached = useMemo(
    () => new Map(cachedList.map((unit) => [unit.readableId, unit])),
    [cachedList],
  );

  const scanner = useScanner({
    onScan: (value) => {
      void session.add(value).then((result) => {
        if (result === 'repeat') {
          setRepeats((list) => [{ key: crypto.randomUUID(), code: value.toUpperCase() }, ...list]);
        }
      });
    },
    onDuplicate: (value) =>
      setRepeats((list) => [{ key: crypto.randomUUID(), code: value.toUpperCase() }, ...list]),
  });

  const newestFirst = [...session.scans].reverse();
  const approved = session.scans.filter(isApproved);
  const flagged = session.scans.filter(isFlagged);
  const queued = session.scans.filter((s) => s.state === 'queued' || s.state === 'uncertain');
  const disposed = session.scans.filter(
    (s) => s.state === 'done' && s.outcome?.result === 'disposed',
  );
  const scannedCodes = new Set(session.scans.map((s) => s.code));
  const waiting = cachedList;
  const waitingScanned = waiting.filter((unit) => scannedCodes.has(unit.readableId)).length;
  const byLocation = new Map<string, CachedApproved[]>();
  for (const unit of waiting) {
    byLocation.set(unit.location.code, [...(byLocation.get(unit.location.code) ?? []), unit]);
  }

  const showDone = finished !== null && !confirming && disposed.length > 0;
  const role = me.roles[0] ? ROLE_LABELS[me.roles[0]] : null;

  const scanMore = async () => {
    await session.clearFinished();
    setRepeats([]);
    setFinished(null);
    scanner.resume();
  };

  const barText = !online
    ? 'Scans stay on this computer until it reconnects. Nothing is disposed offline.'
    : session.scans.length === 0
      ? 'Nothing scanned yet.'
      : `${plural(approved.length, 'unit')} will be disposed. ${plural(
          flagged.length,
          'flagged scan',
        )} stay in stock.${queued.length > 0 ? ` ${queued.length} waiting for a check.` : ''}`;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 py-5 sm:px-8">
        <div className="flex flex-col gap-3">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/disposal-retention">Retention</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Disposal scan</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="grid min-w-0 gap-1">
              <h1 className="text-3xl font-bold tracking-tight">Disposal scan</h1>
              <p className="text-sm text-muted-foreground">
                Scan each unit as it leaves the shelf. Approval alone disposes nothing.
              </p>
            </div>
            {allowed ? (
              <div className="grid gap-1 text-sm">
                <span className="text-[13px] font-semibold text-muted-foreground">Disposed by</span>
                <span className="flex items-center gap-2">
                  <PersonAvatar name={me.displayName} userId={me.id} />
                  <span className="truncate">{me.displayName}</span>
                  {role ? <span className="text-[13px] text-muted-foreground">{role}</span> : null}
                </span>
              </div>
            ) : null}
          </header>
        </div>

        {!allowed ? (
          <Alert role="alert" className="relative overflow-hidden pl-5">
            <StageStripe stage="danger" variant="edge" />
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              Disposal scans need a personal sign-in
            </AlertTitle>
            <AlertDescription className="text-current">
              <p>
                A shared LAB station can’t record disposal, whoever is selected. Sign in with your
                own account to scan units out.
              </p>
            </AlertDescription>
          </Alert>
        ) : !online ? (
          <Alert className="relative overflow-hidden pl-5">
            <StageStripe stage="due" variant="edge" />
            <CloudOff aria-hidden="true" />
            <AlertTitle className="line-clamp-none">This computer is offline</AlertTitle>
            <AlertDescription className="text-current">
              <p>
                Scans are kept on this computer and checked when it reconnects. Disposal is recorded
                only after every unit is checked online and you confirm the list again.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {session.problem && allowed ? (
          <Alert role="alert" className="relative overflow-hidden pl-5">
            <StageStripe stage="due" variant="edge" />
            <CircleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              {problemText(session.problem).title}
            </AlertTitle>
            <AlertDescription className="text-current">
              <p>{problemText(session.problem).body}</p>
              {online && session.problem.kind === 'unavailable' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={session.checkNow}
                >
                  <RotateCw aria-hidden="true" />
                  Check again
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {session.otherAccounts > 0 || session.unreadable > 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {session.otherAccounts > 0
              ? `${plural(session.otherAccounts, 'scan')} taken under another sign-in ${
                  session.otherAccounts === 1 ? 'is' : 'are'
                } kept on this computer for that account. `
              : null}
            {session.unreadable > 0
              ? `${plural(session.unreadable, 'scan')} from a newer Material Mule ${
                  session.unreadable === 1 ? 'is' : 'are'
                } kept and not sent.`
              : null}
          </p>
        ) : null}

        {showDone ? (
          <DoneView
            disposed={disposed}
            flagged={flagged}
            at={finished.at}
            name={me.displayName}
            waiting={waiting.filter((unit) => !scannedCodes.has(unit.readableId))}
            onScanMore={() => void scanMore()}
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div className="flex min-w-0 flex-col gap-4">
              <ScanField
                scanner={scanner}
                label="Scan each unit as it leaves the shelf"
                placeholder="Scan a label or type a storage unit ID"
                description="Each scan shows the unit and whether it’s approved. Units that aren’t approved, on hold or unknown are flagged on their row and not disposed."
                disabled={!allowed || !session.loaded}
              />
              {newestFirst.length === 0 && repeats.length === 0 ? (
                <Empty className="border border-dashed md:p-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ScanLine />
                    </EmptyMedia>
                    <EmptyTitle>Nothing scanned yet.</EmptyTitle>
                    <EmptyDescription>
                      Take an approved unit off its shelf and scan its label. Approved and waiting
                      says where they are.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-[13px] text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      {online
                        ? plural(newestFirst.length, 'scan')
                        : `${plural(newestFirst.length, 'scan')} queued on this computer.`}
                    </span>
                    {online
                      ? ` · ${approved.length} approved · ${flagged.length} flagged${
                          repeats.length > 0 ? ` · ${plural(repeats.length, 'repeat')}` : ''
                        }.`
                      : null}{' '}
                    Newest first.
                  </p>
                  <ItemGroup
                    aria-label="Scanned units, newest first"
                    aria-live="polite"
                    className="gap-2"
                  >
                    {repeats.map((repeat) => (
                      <Item
                        key={repeat.key}
                        variant="outline"
                        size="sm"
                        role="listitem"
                        className="relative bg-muted/50 py-2 pr-2 pl-5"
                      >
                        <StageStripe stage="closed" />
                        <ItemContent className="min-w-0 gap-0.5">
                          <ItemTitle className="flex w-full flex-wrap items-baseline gap-x-3">
                            <span className="font-mono text-[15px] font-semibold whitespace-nowrap">
                              {repeat.code}
                            </span>
                          </ItemTitle>
                          <ItemDescription className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
                            <Copy aria-hidden="true" className="size-3.5" />
                            Already scanned. Counted once.
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove repeat of ${repeat.code}`}
                            onClick={() =>
                              setRepeats((list) => list.filter((r) => r.key !== repeat.key))
                            }
                          >
                            <X />
                          </Button>
                        </ItemActions>
                      </Item>
                    ))}
                    {newestFirst.map((scan) => {
                      const view = rowView(scan, online, cached);
                      const Icon = view.icon;
                      return (
                        <Item
                          key={scan.intentId}
                          variant="outline"
                          size="sm"
                          role="listitem"
                          aria-label={scan.code}
                          className="relative bg-card py-2 pr-2 pl-5"
                        >
                          <StageStripe stage={view.stage} />
                          <ItemContent className="min-w-0 gap-0.5">
                            <ItemTitle className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5">
                              <span className="font-mono text-[15px] font-semibold whitespace-nowrap">
                                {scan.check?.unit?.readableId ?? scan.code}
                              </span>
                              <span className="truncate text-[13px] font-normal text-muted-foreground">
                                {unitLine(scan, cached)}
                              </span>
                            </ItemTitle>
                            <ItemDescription
                              className={
                                view.tone === 'flag'
                                  ? 'flex items-center gap-1.5 text-[13px] font-medium text-destructive-text'
                                  : view.tone === 'ok'
                                    ? 'flex items-center gap-1.5 text-[13px] font-medium text-stage-storage-fg'
                                    : 'flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground'
                              }
                            >
                              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                              {view.text}
                            </ItemDescription>
                          </ItemContent>
                          {scan.state === 'queued' || scan.state === 'checked' ? (
                            <ItemActions>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove scan of ${scan.code}`}
                                onClick={() => {
                                  // Taken off the list: the same label may be scanned again at once.
                                  scanner.resetDuplicates();
                                  void session.remove(scan.intentId);
                                }}
                              >
                                <X />
                              </Button>
                            </ItemActions>
                          ) : null}
                        </Item>
                      );
                    })}
                  </ItemGroup>
                </div>
              )}
            </div>

            <section
              aria-labelledby="disposal-scan-waiting"
              className="flex flex-col gap-3 self-start rounded-xl border bg-card p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h2 id="disposal-scan-waiting" className="text-base font-semibold">
                  Approved and waiting
                </h2>
                <span className="font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                  {waitingScanned} of {waiting.length} scanned
                </span>
              </div>
              <Progress
                value={waiting.length === 0 ? 0 : (waitingScanned / waiting.length) * 100}
                aria-label="Approved units scanned"
                className="h-1.5"
              />
              {online && shownReady === null ? (
                <p className="text-[13px] text-muted-foreground">
                  The approved units couldn’t be loaded.
                </p>
              ) : !online ? (
                <p className="text-[13px] text-muted-foreground">
                  As this computer last saw them online.
                </p>
              ) : null}
              {waiting.length === 0 && shownReady !== 'loading' ? (
                <p className="text-[13px] text-muted-foreground">
                  No units are approved and waiting.
                </p>
              ) : null}
              {[...byLocation.entries()].map(([code, units]) => (
                <div key={code} className="grid gap-1">
                  <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <MapPin aria-hidden="true" className="size-3.5" />
                    <span className="font-mono">{code}</span>
                  </p>
                  <ItemGroup aria-label={`Approved on ${code}`} className="gap-0">
                    {units.map((unit) => {
                      const done = scannedCodes.has(unit.readableId);
                      return (
                        <Item
                          key={unit.readableId}
                          size="sm"
                          role="listitem"
                          className="gap-2 px-0 py-0.5"
                        >
                          <ItemMedia>
                            {done ? (
                              <span className="flex text-stage-storage-fg">
                                <CircleCheck aria-hidden="true" className="size-3.5" />
                                <span className="sr-only">Scanned. </span>
                              </span>
                            ) : (
                              <span className="flex text-muted-foreground">
                                <Circle aria-hidden="true" className="size-3.5" />
                              </span>
                            )}
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle className="gap-2 text-[13px]">
                              <span className="font-mono font-semibold whitespace-nowrap">
                                {unit.readableId}
                              </span>
                              <span className="font-mono font-normal text-muted-foreground">
                                {unit.projectNumber}
                              </span>
                            </ItemTitle>
                          </ItemContent>
                        </Item>
                      );
                    })}
                  </ItemGroup>
                </div>
              ))}
              {shownReady !== null &&
              shownReady !== 'loading' &&
              shownReady.total > shownReady.units.length ? (
                <p className="text-[13px] text-muted-foreground">
                  {`Showing approved units among the first ${shownReady.units.length} ready of ${shownReady.total}.`}
                </p>
              ) : null}
              <p className="border-t pt-3 text-[13px] text-muted-foreground">
                Only these units can be recorded as disposed.{' '}
                <Link
                  className="text-link underline-offset-4 hover:underline"
                  to="/disposal-retention"
                >
                  Open Retention
                </Link>
              </p>
            </section>
          </div>
        )}
      </div>

      {!showDone ? (
        <div className="sticky bottom-0 flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t bg-background px-4 py-3 sm:px-8">
          <p className="mr-auto text-sm text-muted-foreground">{barText}</p>
          <Button
            type="button"
            disabled={!allowed || !online || approved.length === 0 || session.checking}
            onClick={() => setConfirming(true)}
          >
            <PackageX aria-hidden="true" />
            {!online
              ? 'Record disposal when back online'
              : approved.length === 0
                ? 'Record disposal'
                : `Record disposal of ${plural(approved.length, 'unit')}`}
          </Button>
        </div>
      ) : null}

      <BulkConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Record disposal of ${plural(approved.length, 'storage unit')}?`}
        description={`The units are recorded as disposed by ${me.displayName}. They keep their IDs and history, but they can’t be moved, tested or printed again.${
          flagged.length > 0
            ? ` ${plural(flagged.length, 'flagged scan')} ${flagged.length === 1 ? 'isn’t' : 'aren’t'} included and stay${flagged.length === 1 ? 's' : ''} in stock.`
            : ''
        }`}
        irreversibleNote="This can’t be undone."
        records={approved.map((scan) => ({
          id: scan.check?.unit?.readableId ?? scan.code,
          label: scan.check?.unit
            ? [scan.check.unit.projectNumber, ...scan.check.unit.holes].join(' · ')
            : undefined,
        }))}
        confirmLabel={(n) => `Record disposal of ${plural(n, 'unit')}`}
        noun={{ one: 'storage unit', other: 'storage units' }}
        doneWord="disposed"
        onConfirm={async () => {
          const result = await session.record(approved.map((scan) => scan.intentId));
          if (result.succeeded.length > 0) setFinished({ at: new Date().toISOString() });
          return result;
        }}
      />
    </div>
  );
}

function DoneView({
  disposed,
  flagged,
  at,
  name,
  waiting,
  onScanMore,
}: {
  disposed: QueuedScan[];
  flagged: QueuedScan[];
  at: string;
  name: string;
  waiting: CachedApproved[];
  onScanMore: () => void;
}) {
  const shelves = [...new Set(waiting.map((unit) => unit.location.code))];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-stage-storage-bg text-stage-storage-fg">
          <Check aria-hidden="true" className="size-6" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-2xl font-bold">{plural(disposed.length, 'storage unit')} disposed</h2>
          <p className="text-sm text-muted-foreground">
            Recorded by {name} at {timeFormat.format(new Date(at))}. Each keeps its ID and history.
          </p>
        </div>
      </div>
      <ItemGroup
        aria-label="Disposed storage units"
        className="divide-y overflow-hidden rounded-xl border bg-card"
      >
        {disposed.map((scan) => (
          <Item
            key={scan.intentId}
            size="sm"
            role="listitem"
            className="relative rounded-none py-2.5 pr-4 pl-6"
          >
            <StageStripe stage="closed" />
            <ItemContent className="min-w-0">
              <ItemTitle className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[15px] font-semibold whitespace-nowrap">
                  {scan.outcome?.readableId ?? scan.code}
                </span>
                {scan.check?.unit ? (
                  <span className="truncate text-[13px] font-normal text-muted-foreground">
                    {[scan.check.unit.projectNumber, ...scan.check.unit.holes].join(' · ')}
                  </span>
                ) : null}
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Badge variant="closed">Disposed</Badge>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {flagged.length > 0 ? (
        <Alert className="relative overflow-hidden pl-5">
          <StageStripe stage="due" variant="edge" />
          <Undo2 aria-hidden="true" />
          <AlertTitle className="line-clamp-none">
            Put the {plural(flagged.length, 'flagged unit')} back on{' '}
            {flagged.length === 1 ? 'its shelf' : 'their shelves'}
          </AlertTitle>
          <AlertDescription className="text-current">
            <ul className="grid gap-0.5">
              {flagged.map((scan) => (
                <li key={scan.intentId}>
                  <span className="font-mono">{scan.check?.unit?.readableId ?? scan.code}</span>
                  {scan.check?.unit ? (
                    <>
                      {' to '}
                      <span className="font-mono">{scan.check.unit.location.code}</span>
                    </>
                  ) : (
                    ' matched no unit: check its label'
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {waiting.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {plural(waiting.length, 'approved unit')} {waiting.length === 1 ? 'is' : 'are'} still
          waiting on <span className="font-mono">{shelves.join(', ')}</span>.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onScanMore}>
          <ScanLine aria-hidden="true" />
          Scan more
        </Button>
        <Button asChild variant="outline">
          <Link to="/disposal-retention">Back to Retention</Link>
        </Button>
      </div>
    </div>
  );
}
