import type {
  RetentionDecision,
  RetentionDecisionResult,
  RetentionDecisionUnit,
  RetentionDecisionUnits,
} from '@materialmule/shared';
import { CalendarPlus, ListPlus, Lock, Pause, Send } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { notifySuccess } from '../components/strata/toast';
import {
  announceRetentionChanged,
  fetchDecisionUnits,
  postDecision,
  postRetentionRequest,
  type Loaded,
} from './pipeline-api';

export type RetentionChoice = 'extend' | 'hold' | 'dispose';

/**
 * The decision drawer (STRATA-91, DESIGN.md › Round 6). Lane A (Today, Inbox) and the project page
 * open it the same way the Retention page does: give the units (or a project), it loads what the
 * server says about them and decides or sends a request. Every rule is rechecked on the server.
 */
export interface RetentionDecisionDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The units to decide on (storage unit UUIDs, from any page). */
  unitIds?: readonly string[];
  /**
   * Or a whole project: every current unit is listed; with all ticked, Extend and Place a hold
   * apply to the project (later units too).
   */
  projectId?: string;
  /** Where it was opened from, shown above the title, e.g. "Overdue · DEMO-2610". */
  context?: string;
  /** The choice selected first (default Extend). */
  initialChoice?: RetentionChoice;
  /** After a decision or request went through (lists and counts should refresh). */
  onDone?: (result: RetentionDecisionResult | { action: 'request' }) => void;
}

const plural = (n: number, one = 'unit', many = 'units') => `${n} ${n === 1 ? one : many}`;

/** YYYY-MM-DD plus whole months (end of month clamps, as the server's interval does). */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function RetentionDecisionDrawer(props: RetentionDecisionDrawerProps) {
  const { open, onOpenChange } = props;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
        aria-describedby={undefined}
      >
        {open ? <DrawerBody {...props} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  unitIds,
  projectId,
  context,
  initialChoice = 'extend',
  onOpenChange,
  onDone,
}: RetentionDecisionDrawerProps) {
  const target = useMemo(
    () => (projectId ? { projectId } : { unitIds: [...(unitIds ?? [])] }),
    [projectId, unitIds],
  );
  const targetKey = JSON.stringify(target);
  const [loaded, setLoaded] = useState<{
    key: string;
    value: Loaded<RetentionDecisionUnits>;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${targetKey}:${retry}`;
  useEffect(() => {
    let cancelled = false;
    void fetchDecisionUnits(target).then((value) => {
      if (!cancelled) setLoaded({ key, value });
    });
    return () => {
      cancelled = true;
    };
    // `key` covers the target and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const value = loaded?.key === key ? loaded.value : null;
  if (!value) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>Loading the units…</SheetTitle>
        </SheetHeader>
        <div aria-busy="true" className="flex flex-col gap-3 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </>
    );
  }
  if (!value.ok) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>Decide at end of retention</SheetTitle>
        </SheetHeader>
        <div className="p-4">
          <Alert variant="destructive">
            <AlertTitle>The units couldn’t load.</AlertTitle>
            <AlertDescription>
              <p>{value.message}</p>
              <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </>
    );
  }
  return (
    <DecisionForm
      data={value.data}
      context={context}
      initialChoice={initialChoice}
      onClose={() => onOpenChange(false)}
      onDone={onDone}
    />
  );
}

function DecisionForm({
  data,
  context,
  initialChoice,
  onClose,
  onDone,
}: {
  data: RetentionDecisionUnits;
  context?: string;
  initialChoice: RetentionChoice;
  onClose: () => void;
  onDone?: RetentionDecisionDrawerProps['onDone'];
}) {
  const units = data.units;
  // Leads and Lab Managers decide; anyone else asks the lead (server capability per unit).
  const decider = units.length > 0 && units.every((u) => u.canDecide);
  const requester = !decider && data.canRequest;
  const [choice, setChoice] = useState<RetentionChoice>(
    !decider && initialChoice === 'dispose' ? 'extend' : initialChoice,
  );
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(units.map((u) => u.storageUnitId)),
  );
  const [extendBy, setExtendBy] = useState<'months' | 'date'>('months');
  const [months, setMonths] = useState('6');
  const [retainUntil, setRetainUntil] = useState('');
  const [holdKind, setHoldKind] = useState<'released' | 'date'>('released');
  const [holdUntil, setHoldUntil] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState<RetentionDecisionResult['failed']>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const formId = useId();

  const blocked = (u: RetentionDecisionUnit) => choice === 'dispose' && u.listBlockers.length > 0;
  const chosen = units.filter((u) => ticked.has(u.storageUnitId) && !blocked(u));
  const projects = [...new Map(units.map((u) => [u.project.id, u.project])).values()];
  const project = projects.length === 1 ? projects[0]! : null;
  const eligibleCount = units.filter((u) => u.listBlockers.length === 0).length;
  const wholeProject =
    data.projectId !== null && choice !== 'dispose' && chosen.length === units.length;

  const monthsValue = Number.parseInt(months, 10);
  const amountOk =
    choice !== 'extend' ||
    (extendBy === 'months' ? monthsValue >= 1 && monthsValue <= 600 : retainUntil !== '');
  const holdOk = choice !== 'hold' || holdKind === 'released' || holdUntil !== '';
  const reasonOk = reason.trim().length > 0;
  const n = chosen.length;

  const title = requester
    ? `Request hold or extension for ${plural(units.length)}`
    : `Decide on ${plural(units.length)} at end of retention`;
  const primary = requester
    ? 'Send request'
    : choice === 'extend'
      ? `Extend ${plural(n)}`
      : choice === 'hold'
        ? `Place a hold on ${plural(n)}`
        : `Add ${plural(n)} to the disposal list`;
  const PrimaryIcon = requester
    ? Send
    : choice === 'extend'
      ? CalendarPlus
      : choice === 'hold'
        ? Pause
        : ListPlus;

  function toggle(id: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!reasonOk || !amountOk || !holdOk || n === 0 || busy) return;
    setBusy(true);
    setProblem(null);
    setFailed([]);
    const amount =
      choice === 'extend'
        ? extendBy === 'months'
          ? { extendMonths: monthsValue }
          : { retainUntil }
        : {};
    const hold = choice === 'hold' && holdKind === 'date' ? { holdUntil } : {};
    if (requester) {
      const byProject = new Map<string, string[]>();
      for (const u of chosen) {
        byProject.set(u.project.id, [...(byProject.get(u.project.id) ?? []), u.storageUnitId]);
      }
      for (const [pid, ids] of byProject) {
        const sent = await postRetentionRequest({
          kind: choice === 'hold' ? 'hold' : 'extension',
          projectId: pid,
          ...(wholeProject ? {} : { unitIds: ids }),
          ...amount,
          ...hold,
          reason: reason.trim(),
          idempotencyKey: byProject.size === 1 ? idempotencyKey : crypto.randomUUID(),
        });
        if (!sent.ok) {
          setBusy(false);
          setProblem(sent.message);
          return;
        }
      }
      setBusy(false);
      notifySuccess('Request sent.', {
        description: project?.lead
          ? `${project.lead.name} decides. You’ll see the answer in your Inbox.`
          : 'The project’s lead decides. You’ll see the answer in your Inbox.',
      });
      announceRetentionChanged();
      onDone?.({ action: 'request' });
      onClose();
      return;
    }
    const body: RetentionDecision = {
      action: choice,
      ...(wholeProject
        ? { projectId: data.projectId! }
        : { units: chosen.map((u) => ({ id: u.storageUnitId, version: u.version })) }),
      ...amount,
      ...hold,
      reason: reason.trim(),
      idempotencyKey,
    };
    const result = await postDecision(body);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    // A new key for anything sent after this (the failed units, a different choice).
    setIdempotencyKey(crypto.randomUUID());
    const { done, created, failed: refused } = result.data;
    if (done.length > 0 || created.length > 0) {
      const what =
        choice === 'extend'
          ? 'Extended'
          : choice === 'hold'
            ? 'Hold placed on'
            : 'Added to the disposal list:';
      notifySuccess(
        wholeProject
          ? `${what} ${project?.projectNumber ?? 'the project'}.`
          : `${what} ${plural(done.length)}.`,
      );
      announceRetentionChanged();
      onDone?.(result.data);
    }
    if (refused.length > 0) {
      setFailed(refused);
      setTicked(new Set(refused.map((f) => f.storageUnitId)));
      return;
    }
    onClose();
  }

  return (
    <form
      id={formId}
      aria-label={title}
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
    >
      <SheetHeader className="gap-1 border-b">
        {context ? <p className="text-muted-foreground font-mono text-xs">{context}</p> : null}
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          {project ? (
            <>
              <span className="font-mono">{project.projectNumber}</span> {project.name} ·{' '}
              {project.lead ? `Lead ${project.lead.name}` : 'Waiting for a lead'}
            </>
          ) : (
            `${projects.length} projects`
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {units.length === 0 ? (
          <Alert>
            <AlertTitle>No current units to decide on.</AlertTitle>
          </Alert>
        ) : (
          <section aria-labelledby={`${formId}-units`} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={`${formId}-units`} className="text-sm font-semibold">
                Units
              </h3>
              <span className="text-muted-foreground text-xs" aria-live="polite">
                {n} of {units.length} ticked
              </span>
            </div>
            <p className="text-muted-foreground text-xs">Untick to decide some separately.</p>
            <Table aria-label="Units to decide on">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <span className="sr-only">Include</span>
                  </TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="w-[11ch]">Retain until</TableHead>
                  <TableHead className="w-[11ch]">Minimum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((u) => {
                  const off = blocked(u);
                  const fail = failed.find((f) => f.storageUnitId === u.storageUnitId);
                  return (
                    <TableRow
                      key={u.storageUnitId}
                      className={off ? 'bg-stage-danger-bg/40' : undefined}
                    >
                      <TableCell>
                        {off ? (
                          <Lock aria-hidden="true" className="text-muted-foreground size-4" />
                        ) : (
                          <Checkbox
                            aria-label={`Include ${u.readableId}`}
                            checked={ticked.has(u.storageUnitId)}
                            onCheckedChange={(on) => toggle(u.storageUnitId, on === true)}
                          />
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="font-mono">{u.readableId}</div>
                        <div className="text-muted-foreground text-xs">
                          {[u.holes.join(', '), u.hold ? 'On hold' : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                        {off ? (
                          <div className="text-xs">
                            Can’t go on the list: {u.listBlockers.map((b) => b.label).join('; ')}
                          </div>
                        ) : null}
                        {fail ? (
                          <div className="text-destructive text-xs" role="alert">
                            Not done: {fail.message}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono">{u.effectiveRetainUntil}</TableCell>
                      <TableCell className="font-mono">{u.minimumRetainUntil}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="text-muted-foreground text-xs">
              Retain until is the date now in effect, with extensions. Minimum is received + 1 year,
              the earliest retention allows.
            </p>
          </section>
        )}

        {decider || requester ? (
          <FieldSet>
            <FieldLegend variant="label">
              {requester ? 'What should happen' : 'Decision'}
            </FieldLegend>
            <RadioGroup
              value={choice}
              onValueChange={(next) => setChoice(next as RetentionChoice)}
              aria-label={requester ? 'What should happen' : 'Decision'}
            >
              <ChoiceCard
                value="extend"
                title="Extend"
                description="Keep them longer: add months, or set a new retain-until date."
              />
              <ChoiceCard
                value="hold"
                title="Place a hold"
                description="Keep them until a date or until someone releases the hold."
              />
              {decider ? (
                <ChoiceCard
                  value="dispose"
                  title="Add to disposal list"
                  description="Only eligible units can go on it. A lead approves the list before the scan."
                />
              ) : null}
            </RadioGroup>
          </FieldSet>
        ) : (
          <Alert>
            <AlertTitle>You can’t decide or request retention changes.</AlertTitle>
          </Alert>
        )}

        {choice === 'extend' && (decider || requester) ? (
          <FieldSet>
            <RadioGroup
              value={extendBy}
              onValueChange={(next) => setExtendBy(next as 'months' | 'date')}
              aria-label="Extend by"
              className="flex gap-4"
            >
              <InlineRadio value="months" label="Add months" />
              <InlineRadio value="date" label="New retain-until date" />
            </RadioGroup>
            {extendBy === 'months' ? (
              <Field data-invalid={tried && !amountOk}>
                <FieldLabel htmlFor={`${formId}-months`}>Months past the minimum</FieldLabel>
                <Input
                  id={`${formId}-months`}
                  type="number"
                  min={1}
                  max={600}
                  inputMode="numeric"
                  className="w-28 font-mono"
                  value={months}
                  onChange={(event) => setMonths(event.target.value)}
                />
                {project && monthsValue >= 1 && units.length > 0 ? (
                  <FieldDescription>
                    New retain-until{' '}
                    {[...new Set(chosen.map((u) => addMonths(u.minimumRetainUntil, monthsValue)))]
                      .slice(0, 3)
                      .join(', ')}{' '}
                    for {n === 1 ? 'the unit' : 'each unit'}. It never moves a date earlier.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : (
              <Field data-invalid={tried && !amountOk}>
                <FieldLabel htmlFor={`${formId}-date`}>New retain-until</FieldLabel>
                <Input
                  id={`${formId}-date`}
                  type="date"
                  className="w-44 font-mono"
                  value={retainUntil}
                  onChange={(event) => setRetainUntil(event.target.value)}
                />
                {tried && !amountOk ? <FieldError>Choose a date.</FieldError> : null}
              </Field>
            )}
          </FieldSet>
        ) : null}

        {choice === 'hold' && (decider || requester) ? (
          <FieldSet>
            <RadioGroup
              value={holdKind}
              onValueChange={(next) => setHoldKind(next as 'released' | 'date')}
              aria-label="Hold until"
              className="flex gap-4"
            >
              <InlineRadio value="date" label="Until a date" />
              <InlineRadio value="released" label="Until released" />
            </RadioGroup>
            {holdKind === 'date' ? (
              <Field data-invalid={tried && !holdOk}>
                <FieldLabel htmlFor={`${formId}-hold`}>Hold until</FieldLabel>
                <Input
                  id={`${formId}-hold`}
                  type="date"
                  className="w-44 font-mono"
                  value={holdUntil}
                  onChange={(event) => setHoldUntil(event.target.value)}
                />
                {tried && !holdOk ? <FieldError>Choose a date.</FieldError> : null}
              </Field>
            ) : null}
            <FieldDescription>
              Held units are never eligible for disposal until the hold is released. A date is a
              reminder: the hold stays until someone releases it.
            </FieldDescription>
          </FieldSet>
        ) : null}

        {choice === 'dispose' && decider ? (
          <div className="flex flex-col gap-1 text-sm">
            <p>
              {eligibleCount} {eligibleCount === 1 ? 'is' : 'are'} eligible: retain-until reached,
              no hold, programs closed.
            </p>
            <p className="text-muted-foreground text-xs">
              The list is reversible: a lead or Lab Manager can take a unit off it until it’s
              approved. Nothing is disposed until it’s scanned out.
            </p>
          </div>
        ) : null}

        {decider || requester ? (
          <Field data-invalid={tried && !reasonOk}>
            <FieldLabel htmlFor={`${formId}-reason`}>Reason (required)</FieldLabel>
            <Textarea
              id={`${formId}-reason`}
              value={reason}
              aria-invalid={tried && !reasonOk}
              onChange={(event) => setReason(event.target.value)}
            />
            {tried && !reasonOk ? (
              <FieldError>Give a reason. It’s recorded in each unit’s history.</FieldError>
            ) : null}
          </Field>
        ) : null}

        {requester ? (
          <p className="text-muted-foreground text-sm">
            {project?.lead ? `${project.lead.name}, the project’s lead,` : 'The project’s lead'}{' '}
            decides. Your request appears in their Inbox, and you’ll see the answer in yours.
          </p>
        ) : null}

        {problem ? (
          <Alert variant="destructive">
            <AlertTitle>{problem}</AlertTitle>
          </Alert>
        ) : null}
        {failed.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>
              {plural(failed.length)} {failed.length === 1 ? 'wasn’t' : 'weren’t'} changed.
            </AlertTitle>
            <AlertDescription>
              <ul>
                {failed.map((f) => (
                  <li key={f.storageUnitId}>
                    <span className="font-mono">{f.readableId ?? f.storageUnitId}</span>:{' '}
                    {f.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-t">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {decider || requester ? (
          <Button type="submit" disabled={busy || n === 0}>
            <PrimaryIcon aria-hidden="true" />
            {primary}
          </Button>
        ) : null}
      </SheetFooter>
    </form>
  );
}

function ChoiceCard({
  value,
  title,
  description,
}: {
  value: RetentionChoice;
  title: string;
  description: string;
}) {
  const id = useId();
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        <RadioGroupItem value={value} id={id} />
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          <FieldDescription>{description}</FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

function InlineRadio({ value, label }: { value: string; label: string }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="w-auto">
      <RadioGroupItem value={value} id={id} />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
    </Field>
  );
}
