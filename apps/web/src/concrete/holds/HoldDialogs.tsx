import {
  CONCRETE_HOLD_KIND_LABEL,
  concreteRescheduledTarget,
  type ConcreteHoldRow,
  type ReceiverOption,
} from '@materialmule/shared';
import { useId, useState } from 'react';
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
import { BulkConfirmDialog } from '../../components/strata/bulk-confirm-dialog';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { localNow, localToIso } from '../lab/format';
import {
  authorizeDisposal,
  recordDisposal,
  scheduleTest,
  type ActionProblem,
  type ActionResult,
} from './api';
import { holdName, type HoldAction } from './hold-actions';

// The Holds selection bar's three actions (STRATA-95 part B, canvas R7HoldsSelected / Dispose).
// Schedule test and Authorize disposal take a reason and list each specimen with its change;
// Record disposal asks for the removal time and person, then the confirmation that lists every
// ID (BulkConfirmDialog). The server checks each specimen again and changes all or none.

const plural = (n: number) => `${n} ${n === 1 ? 'specimen' : 'specimens'}`;

function problemOf(id: string, problems: ActionProblem[], refused: string[]): string | null {
  return (
    problems.find((p) => p.specimenId === id)?.label ??
    (refused.includes(id) ? 'You can’t act on this specimen' : null)
  );
}

/** Schedule test or Authorize disposal: a reason, each specimen and its change, then confirm. */
function ReasonDialog({
  action,
  rows,
  onClose,
  onDone,
}: {
  action: 'schedule_test' | 'authorize_disposal';
  rows: ConcreteHoldRow[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const formId = useId();
  const [age, setAge] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [problems, setProblems] = useState<ActionProblem[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const scheduling = action === 'schedule_test';
  const ageNumber = /^\d{1,3}$/.test(age.trim()) ? Number(age.trim()) : null;
  const title = `${scheduling ? 'Schedule test' : 'Authorize disposal'}: ${plural(rows.length)}`;

  const changeOf = (row: ConcreteHoldRow) => {
    if (!scheduling) return `${CONCRETE_HOLD_KIND_LABEL[row.holdKind]} → Disposal authorized`;
    if (ageNumber === null || ageNumber < 1 || !row.castingDate) return 'HOLD → test age';
    return `HOLD → ${ageNumber} d, target ${concreteRescheduledTarget(row.castingDate, ageNumber)}`;
  };

  async function confirm() {
    if (busy) return;
    if (scheduling && (ageNumber === null || ageNumber < 1 || ageNumber > 999)) {
      setError({ message: 'Enter a test age of 1 to 999 days', field: 'newAge' });
      return;
    }
    if (reason.trim() === '') {
      setError({ message: 'A reason is required', field: 'reason' });
      return;
    }
    setError(null);
    setBusy(true);
    const items = rows.map((r) => ({ specimenId: r.specimenId, version: r.version }));
    const result: ActionResult = scheduling
      ? await scheduleTest({
          idempotencyKey: key,
          items,
          newAge: ageNumber!,
          reason: reason.trim(),
        })
      : await authorizeDisposal({ idempotencyKey: key, items, reason: reason.trim() });
    setBusy(false);
    if (result.ok) {
      const n = result.data.rows.length;
      onDone(`${plural(n)} ${scheduling ? 'scheduled for testing' : 'authorized for disposal'}.`);
      return;
    }
    // A refusal changed nothing: a new key for the next attempt.
    setKey(crypto.randomUUID());
    setProblems(result.problems ?? []);
    setRefused(result.refused ?? []);
    setError({ message: result.message, field: result.field });
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {scheduling
              ? 'Each specimen leaves HOLD and is tested at casting + the age you choose.'
              : 'This authorizes disposal only. Lab staff record the actual removal later.'}
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          {scheduling ? (
            <Field data-invalid={fieldError('newAge') ? true : undefined}>
              <FieldLabel htmlFor={`${formId}-age`}>Test age (days)</FieldLabel>
              <Input
                id={`${formId}-age`}
                inputMode="numeric"
                className="max-w-32"
                value={age}
                onChange={(e) => setAge(e.target.value)}
              />
              {fieldError('newAge') ? <FieldError>{fieldError('newAge')}</FieldError> : null}
            </Field>
          ) : null}
          <Field data-invalid={fieldError('reason') ? true : undefined}>
            <FieldLabel htmlFor={`${formId}-reason`}>Reason</FieldLabel>
            <Textarea
              id={`${formId}-reason`}
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <FieldDescription>Recorded with each specimen.</FieldDescription>
            {fieldError('reason') ? <FieldError>{fieldError('reason')}</FieldError> : null}
          </Field>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Specimens and changes</h3>
            <ul
              aria-label="Specimens and changes"
              className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm"
            >
              {rows.map((r) => {
                const problem = problemOf(r.specimenId, problems, refused);
                return (
                  <li
                    key={r.specimenId}
                    className="flex flex-wrap items-baseline gap-x-2 px-3 py-1"
                  >
                    <span className="font-mono font-semibold">{holdName(r)}</span>
                    <span className="text-muted-foreground">{r.project.projectNumber}</span>
                    <span className="ml-auto">{changeOf(r)}</span>
                    {problem ? (
                      <span className="w-full text-destructive-text">{problem}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
          {error && error.field !== 'newAge' && error.field !== 'reason' ? (
            <p role="alert" className="text-sm text-destructive-text">
              {error.message}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={scheduling ? 'default' : 'destructive'}
            disabled={busy}
          >
            {busy
              ? 'Saving…'
              : scheduling
                ? `Schedule test for ${plural(rows.length)}`
                : `Authorize disposal of ${plural(rows.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Record disposal: when and who, then the confirmation listing every ID. */
function RecordDisposalFlow({
  rows,
  sharedStation,
  onClose,
  onDone,
}: {
  rows: ConcreteHoldRow[];
  sharedStation: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const formId = useId();
  const [removedAt, setRemovedAt] = useState(localNow);
  const [performer, setPerformer] = useState<ReceiverOption | null>(null);
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<{ message: string; field: string } | null>(null);
  const title = `Record disposal: ${plural(rows.length)}`;

  const next = () => {
    if (!localToIso(removedAt)) {
      setError({ message: 'Enter the date and time of removal', field: 'disposedAt' });
      return;
    }
    if (sharedStation && !performer) {
      setError({ message: 'Choose who removed the specimens', field: 'performedByUserId' });
      return;
    }
    setError(null);
    setStep('confirm');
  };

  return (
    <>
      <Dialog
        open={step === 'details'}
        onOpenChange={(open) => (open || step !== 'details' ? undefined : onClose())}
      >
        <DialogContent className="sm:max-w-[30rem]">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              The actual removal of specimens already authorized for disposal.
            </DialogDescription>
          </DialogHeader>
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              next();
            }}
          >
            <Field data-invalid={error?.field === 'disposedAt' ? true : undefined}>
              <FieldLabel htmlFor={`${formId}-at`}>Removed at</FieldLabel>
              <Input
                id={`${formId}-at`}
                type="datetime-local"
                className="max-w-64"
                value={removedAt}
                onChange={(e) => setRemovedAt(e.target.value)}
              />
              <FieldDescription>Not before the authorization, not in the future.</FieldDescription>
              {error?.field === 'disposedAt' ? <FieldError>{error.message}</FieldError> : null}
            </Field>
            {sharedStation ? (
              <ReceiverSelect
                label="Removed by"
                required
                stationPerson="follow"
                value={performer}
                onChange={setPerformer}
                error={error?.field === 'performedByUserId' ? error.message : null}
                hint="Who physically removed the specimens. Attribution only."
              />
            ) : (
              <p className="text-sm text-muted-foreground">Recorded as removed by you.</p>
            )}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BulkConfirmDialog
        open={step === 'confirm'}
        onOpenChange={(open) => {
          if (!open) setStep('details');
        }}
        title={`Record disposal of ${plural(rows.length)}?`}
        description="The specimens keep their IDs and history; the removal time and the person can’t be changed later."
        irreversibleNote="This can’t be undone."
        records={rows.map((r) => ({
          id: holdName(r),
          label: `${r.project.projectNumber}${
            r.disposal
              ? ` · authorized ${r.disposal.authorizedAt.slice(0, 10)} by ${r.disposal.authorizedBy.name}`
              : ''
          }`,
        }))}
        noun={{ one: 'specimen', other: 'specimens' }}
        confirmLabel={(n) => `Record disposal of ${plural(n)}`}
        onConfirm={async () => {
          const result = await recordDisposal({
            idempotencyKey: key,
            specimenIds: rows.map((r) => r.specimenId),
            disposedAt: localToIso(removedAt)!,
            ...(sharedStation && performer ? { performedByUserId: performer.id } : {}),
          });
          if (!result.ok) {
            const detail = (result.problems ?? [])
              .map((p) => {
                const row = rows.find((r) => r.specimenId === p.specimenId);
                return `${row ? holdName(row) : 'A specimen'}: ${p.label}`;
              })
              .join('; ');
            throw new Error(detail ? `${result.message} ${detail}.` : result.message);
          }
          onDone(`${plural(result.data.rows.length)} recorded as disposed.`);
        }}
      />
    </>
  );
}

export function HoldActionDialogs({
  action,
  rows,
  sharedStation,
  onClose,
  onDone,
}: {
  action: HoldAction | null;
  rows: ConcreteHoldRow[];
  sharedStation: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  if (action === null) return null;
  if (action === 'record_disposal') {
    return (
      <RecordDisposalFlow
        rows={rows}
        sharedStation={sharedStation}
        onClose={onClose}
        onDone={onDone}
      />
    );
  }
  return <ReasonDialog action={action} rows={rows} onClose={onClose} onDone={onDone} />;
}
