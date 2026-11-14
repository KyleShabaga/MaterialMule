import { concreteRescheduledTarget, concreteTargetDateFlags } from '@materialmule/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { holdUntil } from '../holds/api';
import { fetchHolidayDates } from '../../settings/reference/api';
import { rescheduleSpecimen } from './api';
import { ageText, holdBlock, rescheduleBlock, specimenLabel, type Picked } from './breaks-model';

type Outcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * Reschedule from the Breaks selection bar (STRATA-95): a new test age in days for every picked
 * specimen that allows it, each with its age and date before → after. Specimens that can't be
 * rescheduled are named with the reason. The server takes one specimen at a time, so each one is
 * sent with its own idempotency key (kept for a retry) and reported on its own.
 */
export function RescheduleDialog({
  picked,
  onClose,
  onDone,
}: {
  picked: readonly Picked[];
  onClose: () => void;
  /** Called after at least one specimen changed (reload the list). */
  onDone: (message: string | null) => void;
}) {
  const eligible = picked.filter((p) => rescheduleBlock(p) === null);
  const blocked = picked.filter((p) => rescheduleBlock(p) !== null);
  const [age, setAge] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ field: 'age' | 'reason'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const keys = useRef(new Map<string, { body: string; key: string }>());
  const [holidays, setHolidays] = useState<ReadonlySet<string>>(new Set());
  const ageId = useId();
  const reasonId = useId();

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
  const valid = days !== null && days >= 1;
  const pending = eligible.filter((p) => outcomes[p.row.specimenId]?.ok !== true);

  function keyFor(specimenId: string, body: string): string {
    const known = keys.current.get(specimenId);
    if (known && known.body === body) return known.key;
    const key = crypto.randomUUID();
    keys.current.set(specimenId, { body, key });
    return key;
  }

  async function submit() {
    if (busy) return;
    if (!valid) {
      setError({ field: 'age', message: 'Enter the new test age: 1 to 999 days.' });
      return;
    }
    if (reason.trim() === '') {
      setError({ field: 'reason', message: 'A reason is required.' });
      return;
    }
    setError(null);
    setBusy(true);
    const next: Record<string, Outcome> = { ...outcomes };
    const targets = new Map<string, string>();
    for (const { row } of pending) {
      const body = { version: row.version, newAge: days, reason: reason.trim() };
      const result = await rescheduleSpecimen(row.specimenId, {
        idempotencyKey: keyFor(row.specimenId, JSON.stringify(body)),
        ...body,
      });
      if (result.ok && result.data.targetDate) targets.set(row.specimenId, result.data.targetDate);
      next[row.specimenId] = result.ok
        ? {
            ok: true,
            text: `Rescheduled to ${result.data.assignedAge} days (test date ${result.data.targetDate}).`,
          }
        : { ok: false, text: result.message };
      setOutcomes({ ...next });
    }
    setBusy(false);
    const failed = eligible.filter((p) => next[p.row.specimenId]?.ok !== true);
    if (failed.length === 0) {
      const only = eligible.length === 1 ? eligible[0]!.row : null;
      const target = only ? targets.get(only.specimenId) : null;
      onDone(
        only && target
          ? `Rescheduled ${specimenLabel(only)} to ${days} days (test date ${target}).`
          : `Rescheduled ${eligible.length} specimens to ${days} days.`,
      );
    }
  }

  const changed = Object.values(outcomes).some((outcome) => outcome.ok);

  function close() {
    if (busy) return;
    if (changed) onDone(null);
    else onClose();
  }

  const count = eligible.length;
  const title =
    count === 0
      ? 'Nothing to reschedule'
      : `Reschedule ${count} ${count === 1 ? 'specimen' : 'specimens'}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pick a new test age in days. Each test date becomes its casting date plus the new age;
            it is never a free date.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field data-invalid={error?.field === 'age' || undefined}>
            <FieldLabel htmlFor={ageId}>New test age (days)</FieldLabel>
            <Input
              id={ageId}
              inputMode="numeric"
              autoComplete="off"
              className="w-32"
              value={age}
              disabled={count === 0}
              onChange={(event) => setAge(event.target.value)}
              aria-invalid={error?.field === 'age' || undefined}
            />
            {error?.field === 'age' ? <FieldError>{error.message}</FieldError> : null}
          </Field>
          {count > 0 ? (
            <ul aria-label="Specimens to reschedule" className="flex flex-col gap-1 text-sm">
              {eligible.map(({ row }) => {
                const after = valid ? concreteRescheduledTarget(row.castingDate, days) : null;
                const flags = after ? concreteTargetDateFlags(after, holidays) : [];
                const outcome = outcomes[row.specimenId];
                return (
                  <li key={row.specimenId} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono font-semibold">{specimenLabel(row)}</span>
                    <span className="text-muted-foreground">
                      {ageText(row.assignedAge)}{' '}
                      <span className="font-mono">{row.targetDate ?? '—'}</span>
                      {after ? (
                        <>
                          {' → '}
                          {days}-day <span className="font-mono text-foreground">{after}</span>
                          {flags.includes('weekend_target') ? ' (weekend: kept and flagged)' : ''}
                          {flags.includes('holiday_target') ? ' (holiday: kept and flagged)' : ''}
                        </>
                      ) : null}
                    </span>
                    {outcome ? (
                      <span
                        className={
                          outcome.ok ? 'text-stage-storage-fg' : 'font-medium text-destructive'
                        }
                      >
                        {outcome.text}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {blocked.length > 0 ? (
            <ul aria-label="Not included" className="flex flex-col gap-1 text-sm">
              {blocked.map((p) => (
                <li key={p.row.specimenId}>
                  <span className="font-mono font-semibold">{specimenLabel(p.row)}</span> isn’t
                  included: {rescheduleBlock(p)}.
                </li>
              ))}
            </ul>
          ) : null}
          <Field data-invalid={error?.field === 'reason' || undefined}>
            <FieldLabel htmlFor={reasonId}>Reason</FieldLabel>
            <Textarea
              id={reasonId}
              rows={3}
              maxLength={2000}
              value={reason}
              disabled={count === 0}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error?.field === 'reason' || undefined}
            />
            <FieldDescription>Recorded in each specimen’s schedule history.</FieldDescription>
            {error?.field === 'reason' ? <FieldError>{error.message}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              {changed ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy || count === 0 || pending.length === 0}>
              {busy ? 'Saving…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hold until from the Breaks selection bar (STRATA-121): the picked specimens go on an ordinary
 * HOLD until a date after the lab's today, with a required reason. All or nothing on the server;
 * specimens it refuses are named with their reason and nothing changes.
 */
export function HoldUntilDialog({
  picked,
  today,
  onClose,
  onDone,
}: {
  picked: readonly Picked[];
  /** The lab's business date (America/Edmonton). */
  today: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const eligible = picked.filter((p) => holdBlock(p) === null);
  const blocked = picked.filter((p) => holdBlock(p) !== null);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ field?: 'date' | 'reason'; message: string } | null>(null);
  const [problems, setProblems] = useState<{ specimenId: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const sent = useRef<{ body: string; key: string } | null>(null);
  const dateId = useId();
  const reasonId = useId();

  const labelOf = (specimenId: string) => {
    const found = picked.find((p) => p.row.specimenId === specimenId);
    return found ? specimenLabel(found.row) : 'A specimen';
  };

  async function submit() {
    if (busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError({ field: 'date', message: 'Choose the date to hold until.' });
      return;
    }
    if (date <= today) {
      setError({ field: 'date', message: `Choose a date after today (${today}).` });
      return;
    }
    if (reason.trim() === '') {
      setError({ field: 'reason', message: 'A reason is required.' });
      return;
    }
    setError(null);
    setProblems([]);
    const body = {
      items: eligible.map(({ row }) => ({ specimenId: row.specimenId, version: row.version })),
      holdUntil: date,
      reason: reason.trim(),
    };
    const bodyText = JSON.stringify(body);
    const key = sent.current?.body === bodyText ? sent.current.key : crypto.randomUUID();
    sent.current = { body: bodyText, key };
    setBusy(true);
    const result = await holdUntil({ idempotencyKey: key, ...body });
    setBusy(false);
    if (result.ok) {
      onDone(
        `Put ${eligible.length} ${eligible.length === 1 ? 'specimen' : 'specimens'} on HOLD until ${date}.`,
      );
      return;
    }
    const field =
      result.field === 'holdUntil' ? 'date' : result.field === 'reason' ? 'reason' : undefined;
    setError({ field, message: result.message });
    setProblems([
      ...(result.problems ?? []).map((p) => ({ specimenId: p.specimenId, label: p.label })),
      ...(result.refused ?? []).map((specimenId) => ({
        specimenId,
        label: 'You can’t put this specimen on HOLD',
      })),
    ]);
  }

  const count = eligible.length;
  const title =
    count === 0
      ? 'Nothing to put on HOLD'
      : `Hold ${count} ${count === 1 ? 'specimen' : 'specimens'} until a date`;
  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            They go on an ordinary HOLD and come off the Breaks list. Their age and test date are
            kept in the history. Nothing is tested, released or disposed of on the date: it only
            flags the HOLD for review.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {count > 0 ? (
            <p className="text-sm">
              <span className="sr-only">Specimens: </span>
              {eligible.map(({ row }, i) => (
                <span key={row.specimenId}>
                  {i > 0 ? ', ' : ''}
                  <span className="font-mono font-semibold">{specimenLabel(row)}</span>
                </span>
              ))}
            </p>
          ) : null}
          {blocked.length > 0 ? (
            <ul aria-label="Not included" className="flex flex-col gap-1 text-sm">
              {blocked.map((p) => (
                <li key={p.row.specimenId}>
                  <span className="font-mono font-semibold">{specimenLabel(p.row)}</span> isn’t
                  included: {holdBlock(p)}.
                </li>
              ))}
            </ul>
          ) : null}
          <Field data-invalid={error?.field === 'date' || undefined}>
            <FieldLabel htmlFor={dateId}>Hold until</FieldLabel>
            <Input
              id={dateId}
              type="date"
              className="w-44"
              min={today}
              value={date}
              disabled={count === 0}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={error?.field === 'date' || undefined}
            />
            {error?.field === 'date' ? <FieldError>{error.message}</FieldError> : null}
          </Field>
          <Field data-invalid={error?.field === 'reason' || undefined}>
            <FieldLabel htmlFor={reasonId}>Reason</FieldLabel>
            <Textarea
              id={reasonId}
              rows={3}
              maxLength={2000}
              value={reason}
              disabled={count === 0}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error?.field === 'reason' || undefined}
            />
            <FieldDescription>Recorded in each specimen’s HOLD history.</FieldDescription>
            {error?.field === 'reason' ? <FieldError>{error.message}</FieldError> : null}
          </Field>
          {error && !error.field ? (
            <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
              <p className="font-medium">{error.message}</p>
              {problems.length > 0 ? (
                <ul aria-label="Not eligible" className="flex flex-col gap-0.5">
                  {problems.map((p) => (
                    <li key={p.specimenId}>
                      <span className="font-mono font-semibold">{labelOf(p.specimenId)}</span>:{' '}
                      {p.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || count === 0}>
              {busy ? 'Saving…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
