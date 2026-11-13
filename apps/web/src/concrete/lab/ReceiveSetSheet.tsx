import {
  concreteMassSchema,
  concreteTemperatureSchema,
  type ConcreteReceivingSpecimen,
  type MeResponse,
  type ReceiverOption,
} from '@materialmule/shared';
import { Info, ScanLine } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { useMe } from '../../session/context';
import {
  confirmMarkers,
  fetchSetLookup,
  recordPickup,
  recordReceipt,
  type LoadResult,
  type SetLookup,
} from './api';
import {
  ageDays,
  fieldReportPath,
  labStamp,
  localNow,
  localToIso,
  setLabel,
  specimenName,
  UNCAST_DETAIL,
  UNCAST_NOTE,
} from './format';

// Receiving → receive or pick up one set (STRATA-95 part B, canvas R7ReceivingSet / Pickup). The
// C06 rules stay on the server: each specimen's receipt saves on its own (a partial arrival is
// fine), one unmoulded mass to 0.1 g, the actual receiver and time; a pickup marked complete
// needs the collector, time and both curing readings. A personal account is the person unless
// it names someone else; the LAB station starts blank and must name them (as storage-unit
// receipts do, T8/AC5). Sets without a casting time are received like any other (STRATA-120).

export type SheetMode = 'receive' | 'pickup';

const newKey = () => crypto.randomUUID();

/** A personal account receives as itself (changeable); LAB starts blank and must choose. */
function defaultPerson(me: MeResponse): ReceiverOption | null {
  return me.accountType !== 'shared_lab' && me.initials
    ? { id: me.id, initials: me.initials, displayName: me.displayName }
    : null;
}

/** The person field's request value: omitted when a personal account records as itself. */
function personFor(me: MeResponse, person: ReceiverOption | null): string | undefined {
  if (!person) return undefined;
  return me.accountType !== 'shared_lab' && person.id === me.id ? undefined : person.id;
}

const errorOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : (result.error?.issues[0]?.message ?? 'Check this value');

function receivingLine(s: ConcreteReceivingSpecimen): string {
  if (s.receipt) {
    return `Received ${labStamp(s.receipt.receivedAt)} by ${s.receipt.receivedBy.name} · ${s.receipt.massG} g`;
  }
  if (s.state === 'missing_resolved') return 'Missing (resolved)';
  if (s.pickup?.completed && s.pickup.collectedAt) {
    return `Picked up ${labStamp(s.pickup.collectedAt)}`;
  }
  return 'Pickup not recorded';
}

export function ReceiveSetSheet({
  setId,
  mode,
  scannedLetter = null,
  onClose,
  onDone,
}: {
  /** The set to act on; null closes the sheet. */
  setId: string | null;
  mode: SheetMode;
  /** A scanned specimen's letter: ticked when the set opens. */
  scannedLetter?: string | null;
  onClose: () => void;
  /** After something was saved, with the words for the toast. */
  onDone: (message: string) => void;
}) {
  return (
    <Sheet open={setId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-0 sm:max-w-[34rem]">
        {setId ? (
          <SetLoader
            key={`${setId}|${mode}|${scannedLetter ?? ''}`}
            setId={setId}
            mode={mode}
            scannedLetter={scannedLetter}
            onClose={onClose}
            onDone={onDone}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function SetLoader({
  setId,
  mode,
  scannedLetter,
  onClose,
  onDone,
}: {
  setId: string;
  mode: SheetMode;
  scannedLetter: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{ attempt: number; result: LoadResult<SetLookup> } | null>(null);
  useEffect(() => {
    let current = true;
    void fetchSetLookup(setId).then((result) => current && setLoad({ attempt, result }));
    return () => {
      current = false;
    };
  }, [setId, attempt]);

  const result = load?.attempt === attempt ? load.result : null;
  const title = mode === 'receive' ? 'Receive set' : 'Record pickup';
  if (!result) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Loading the set…</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-4" aria-busy="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </>
    );
  }
  if (!result.ok) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{result.message}</SheetDescription>
        </SheetHeader>
        <SheetFooter className="flex-row justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {result.notFound ? null : (
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          )}
        </SheetFooter>
      </>
    );
  }
  return mode === 'receive' ? (
    <ReceiveForm
      data={result.data}
      scannedLetter={scannedLetter}
      onClose={onClose}
      onDone={onDone}
      onReload={() => setAttempt((n) => n + 1)}
    />
  ) : (
    <PickupForm data={result.data} onClose={onClose} onDone={onDone} />
  );
}

function SetHeading({ data, verb }: { data: SetLookup; verb: string }) {
  const { set, report } = data;
  const name = setLabel(set.identity);
  const type = `${set.mouldSize ? `${set.mouldSize} ` : ''}${set.specimenType}`;
  return (
    <SheetHeader className="border-b">
      <SheetTitle>
        {verb} <span className="font-mono">{name}</span>
      </SheetTitle>
      <SheetDescription>
        <span className="font-mono whitespace-nowrap">{report.projectNumber}</span>{' '}
        {report.projectName} ·{' '}
        <Link className="underline-offset-4 hover:underline" to={fieldReportPath(report.id)}>
          Field report
          {report.fields.reportDate ? (
            <>
              {' '}
              <span className="font-mono whitespace-nowrap">{report.fields.reportDate}</span>
            </>
          ) : null}
        </Link>
        {report.fields.paperFieldId ? ` · Field ID ${report.fields.paperFieldId}` : ''} ·{' '}
        {set.castAt ? (
          <>
            cast <span className="font-mono whitespace-nowrap">{labStamp(set.castAt)}</span>
          </>
        ) : (
          UNCAST_NOTE.toLowerCase()
        )}{' '}
        · {type}
      </SheetDescription>
    </SheetHeader>
  );
}

function UncastNote({ castAt }: { castAt: string | null }) {
  if (castAt) return null;
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertTitle>{UNCAST_NOTE}</AlertTitle>
      <AlertDescription>
        {UNCAST_DETAIL}. The set can still be picked up and received; its test dates and HOLD expiry
        follow once the casting time is recorded.
      </AlertDescription>
    </Alert>
  );
}

function ReceiveForm({
  data,
  scannedLetter,
  onClose,
  onDone,
  onReload,
}: {
  data: SetLookup;
  scannedLetter: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
  onReload: () => void;
}) {
  const me = useMe();
  const station = me.accountType === 'shared_lab';
  const formId = useId();
  const name = setLabel(data.set.identity);
  const ageOf = new Map(data.set.specimens.map((s) => [s.id, s.assignedAge]));
  const specimens = data.receiving.specimens;
  const open = (s: ConcreteReceivingSpecimen) =>
    s.state === 'awaiting_pickup' || s.state === 'picked_up';
  const scanned = scannedLetter
    ? specimens.find((s) => s.letter === scannedLetter && open(s))
    : undefined;
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(scanned ? [scanned.specimenId] : []),
  );
  const [mass, setMass] = useState<Record<string, string>>({});
  const [keys] = useState(() => new Map<string, string>());
  const [receiver, setReceiver] = useState<ReceiverOption | null>(() => defaultPerson(me));
  const [receivedAt, setReceivedAt] = useState(localNow);
  const [markers, setMarkers] = useState(false);
  const [markerKey] = useState(newKey);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const numbered = data.set.identity.permanentId !== null;
  const chosen = specimens.filter((s) => ticked.has(s.specimenId));

  const toggle = (id: string, on: boolean) =>
    setTicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function submit() {
    if (busy) return;
    const found: Record<string, string> = {};
    for (const s of chosen) {
      const problem = errorOf(concreteMassSchema.safeParse(mass[s.specimenId] ?? ''));
      if (problem) found[s.specimenId] = problem;
    }
    if (station && !receiver) found.receiver = 'Choose who received them';
    const at = localToIso(receivedAt);
    if (!at) found.receivedAt = 'Enter when they were received';
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0 || chosen.length === 0) return;
    setBusy(true);
    const done: string[] = [];
    const failed: Record<string, string> = {};
    for (const s of chosen) {
      if (!keys.has(s.specimenId)) keys.set(s.specimenId, newKey());
      const result = await recordReceipt(s.specimenId, {
        idempotencyKey: keys.get(s.specimenId)!,
        receivedAt: at!,
        massG: (mass[s.specimenId] ?? '').trim(),
        ...(personFor(me, receiver) ? { receivedByUserId: personFor(me, receiver) } : {}),
      });
      if (result.ok) done.push(specimenName(name, s.letter));
      else {
        failed[s.specimenId] = result.message;
        // A refusal changed nothing: the next attempt is a new request.
        if (result.code) keys.delete(s.specimenId);
      }
    }
    let markerNote = '';
    if (markers && done.length > 0) {
      const confirmed = await confirmMarkers(data.set.id, {
        idempotencyKey: markerKey,
        confirmedAt: at!,
        ...(personFor(me, receiver) ? { confirmedByUserId: personFor(me, receiver) } : {}),
      });
      markerNote = confirmed.ok ? ' Permanent IDs confirmed.' : ` ${confirmed.message}`;
      if (!confirmed.ok) failed.markers = confirmed.message;
    }
    setBusy(false);
    if (Object.keys(failed).length === 0) {
      onDone(
        `Received ${done.length} ${done.length === 1 ? 'specimen' : 'specimens'} of ${name}.${markerNote}`,
      );
      return;
    }
    setErrors(failed);
    setFailure(
      done.length > 0
        ? `${done.length} of ${chosen.length} received (${done.join(', ')}). The rest weren’t saved.`
        : 'Nothing was saved.',
    );
    if (done.length > 0) onReload();
  }

  return (
    <>
      <SetHeading data={data} verb="Receive set" />
      <form
        id={formId}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <UncastNote castAt={data.set.castAt} />
        {scanned ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <ScanLine aria-hidden="true" className="size-4" />
            <span>
              <span className="font-mono">{specimenName(name, scanned.letter)}</span> scanned and
              ticked
            </span>
          </p>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Specimens</legend>
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Specimens">
            {specimens.map((s) => {
              const id = specimenName(name, s.letter);
              const canTick = open(s);
              const on = ticked.has(s.specimenId);
              const error = errors[s.specimenId];
              return (
                <li key={s.specimenId} className="flex flex-col gap-2 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`${formId}-${s.specimenId}`}
                      checked={on}
                      disabled={!canTick}
                      aria-label={`Receive ${id}`}
                      onCheckedChange={(value) => toggle(s.specimenId, value === true)}
                    />
                    <Label
                      htmlFor={`${formId}-${s.specimenId}`}
                      className="font-mono font-semibold whitespace-nowrap"
                    >
                      {id}
                    </Label>
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {ageDays(ageOf.get(s.specimenId) ?? s.assignedAge)}
                    </span>
                    <span className="ml-auto text-right text-[13px] text-muted-foreground">
                      {receivingLine(s)}
                    </span>
                  </div>
                  {on ? (
                    <Field data-invalid={error ? true : undefined} className="pl-7">
                      <FieldLabel htmlFor={`${formId}-${s.specimenId}-mass`}>
                        Mass of {id}
                      </FieldLabel>
                      <InputGroup className="max-w-48">
                        <InputGroupInput
                          id={`${formId}-${s.specimenId}-mass`}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={error ? true : undefined}
                          value={mass[s.specimenId] ?? ''}
                          onChange={(e) =>
                            setMass((now) => ({ ...now, [s.specimenId]: e.target.value }))
                          }
                        />
                        <InputGroupAddon align="inline-end">g</InputGroupAddon>
                      </InputGroup>
                      {error ? <FieldError>{error}</FieldError> : null}
                    </Field>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-[13px] text-muted-foreground">
            One unmoulded mass per specimen, to 0.1 g. Each specimen saves on its own, so a partial
            arrival is fine.
          </p>
        </fieldset>
        <ReceiverSelect
          label="Received by"
          required={station}
          value={receiver}
          onChange={setReceiver}
          error={errors.receiver}
          hint={
            station
              ? 'Who received them. Attribution only.'
              : 'You, unless someone else received them.'
          }
        />
        <Field data-invalid={errors.receivedAt ? true : undefined}>
          <FieldLabel htmlFor={`${formId}-at`}>Received at</FieldLabel>
          <Input
            id={`${formId}-at`}
            type="datetime-local"
            className="max-w-64"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
          {errors.receivedAt ? <FieldError>{errors.receivedAt}</FieldError> : null}
        </Field>
        <Field orientation="horizontal" data-disabled={numbered ? undefined : true}>
          <Checkbox
            id={`${formId}-markers`}
            checked={markers}
            disabled={!numbered}
            onCheckedChange={(value) => setMarkers(value === true)}
          />
          <FieldContent>
            <FieldLabel htmlFor={`${formId}-markers`}>
              Permanent IDs added to all received specimens
            </FieldLabel>
            <FieldDescription>
              {numbered
                ? 'Confirms the markings on what you receive now. A later arrival needs its own confirmation.'
                : 'Number this set first: permanent IDs are confirmed on a numbered set.'}
            </FieldDescription>
            {errors.markers ? <FieldError>{errors.markers}</FieldError> : null}
          </FieldContent>
        </Field>
        {failure ? (
          <p role="alert" className="text-sm text-destructive-text">
            {failure}
          </p>
        ) : null}
      </form>
      <SheetFooter className="flex-row justify-end border-t">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={busy || chosen.length === 0}>
          {busy
            ? 'Saving…'
            : `Receive ${chosen.length} ${chosen.length === 1 ? 'specimen' : 'specimens'}`}
        </Button>
      </SheetFooter>
    </>
  );
}

function PickupForm({
  data,
  onClose,
  onDone,
}: {
  data: SetLookup;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const me = useMe();
  const station = me.accountType === 'shared_lab';
  const formId = useId();
  const name = setLabel(data.set.identity);
  const pickupWindow = data.receiving.pickupWindow;
  const waiting = data.receiving.specimens.filter((s) => s.state === 'awaiting_pickup');
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(waiting.map((s) => s.specimenId)),
  );
  const [collector, setCollector] = useState<ReceiverOption | null>(() => defaultPerson(me));
  const [collectedAt, setCollectedAt] = useState(localNow);
  const [minC, setMinC] = useState('');
  const [maxC, setMaxC] = useState('');
  const [box, setBox] = useState('');
  const [where, setWhere] = useState('');
  const [key, setKey] = useState(newKey);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = waiting.filter((s) => ticked.has(s.specimenId));

  async function submit() {
    if (busy) return;
    const found: Record<string, string> = {};
    if (station && !collector) found.collector = 'Choose who collected them';
    const at = localToIso(collectedAt);
    if (!at) found.collectedAt = 'Enter when they were collected';
    const min = concreteTemperatureSchema.safeParse(minC);
    const max = concreteTemperatureSchema.safeParse(maxC);
    if (!minC.trim()) found.minC = 'Enter the minimum curing temperature';
    else if (!min.success) found.minC = errorOf(min)!;
    if (!maxC.trim()) found.maxC = 'Enter the maximum curing temperature';
    else if (!max.success) found.maxC = errorOf(max)!;
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0 || chosen.length === 0) return;
    setBusy(true);
    const result = await recordPickup(data.set.id, {
      idempotencyKey: key,
      specimens: chosen.map((s) => ({ id: s.specimenId, version: s.pickup?.version ?? null })),
      complete: true,
      // Omitted for a personal account collecting as itself (the server records it as such).
      ...(personFor(me, collector) ? { collectedByUserId: personFor(me, collector) } : {}),
      collectedAt: at,
      curingMinC: minC.trim(),
      curingMaxC: maxC.trim(),
      curingBox: box.trim() || null,
      curingLocation: where.trim() || null,
    });
    setBusy(false);
    if (result.ok) {
      onDone(
        `Recorded pickup of ${chosen.length} ${chosen.length === 1 ? 'specimen' : 'specimens'} of ${name}.`,
      );
      return;
    }
    if (result.code) setKey(newKey());
    setFailure(result.message);
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    unit?: string,
    hint?: ReactNode,
  ) => (
    <Field data-invalid={errors[id] ? true : undefined}>
      <FieldLabel htmlFor={`${formId}-${id}`}>{label}</FieldLabel>
      {unit ? (
        <InputGroup className="max-w-40">
          <InputGroupInput
            id={`${formId}-${id}`}
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={errors[id] ? true : undefined}
            value={value}
            onChange={(e) => set(e.target.value)}
          />
          <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
        </InputGroup>
      ) : (
        <Input
          id={`${formId}-${id}`}
          autoComplete="off"
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      {errors[id] ? <FieldError>{errors[id]}</FieldError> : null}
    </Field>
  );

  return (
    <>
      <SetHeading data={data} verb="Record pickup ·" />
      <form
        id={formId}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <UncastNote castAt={data.set.castAt} />
        <p className="text-[13px] text-muted-foreground">
          {pickupWindow.endsAt ? (
            <>
              Pick up by <span className="font-mono">{labStamp(pickupWindow.endsAt)}</span> ·{' '}
            </>
          ) : null}
          {pickupWindow.verified ? '' : 'Estimate · window not verified. '}The pick-up window never
          records a pickup.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Specimens collected</legend>
          {waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every specimen is picked up.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border" aria-label="Specimens">
              {waiting.map((s) => {
                const id = specimenName(name, s.letter);
                return (
                  <li key={s.specimenId} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={`${formId}-${s.specimenId}`}
                      checked={ticked.has(s.specimenId)}
                      aria-label={`Picked up ${id}`}
                      onCheckedChange={(value) =>
                        setTicked((now) => {
                          const next = new Set(now);
                          if (value === true) next.add(s.specimenId);
                          else next.delete(s.specimenId);
                          return next;
                        })
                      }
                    />
                    <Label
                      htmlFor={`${formId}-${s.specimenId}`}
                      className="font-mono font-semibold"
                    >
                      {id}
                    </Label>
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {ageDays(s.assignedAge)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[13px] text-muted-foreground">
            Partial pickup: untick the specimens left on site.
          </p>
        </fieldset>
        <ReceiverSelect
          label="Collected by"
          required={station}
          value={collector}
          onChange={setCollector}
          error={errors.collector}
          hint={
            station
              ? 'Who collected them from site. Attribution only.'
              : 'You, unless someone else collected them.'
          }
        />
        <Field data-invalid={errors.collectedAt ? true : undefined}>
          <FieldLabel htmlFor={`${formId}-at`}>Collected at</FieldLabel>
          <Input
            id={`${formId}-at`}
            type="datetime-local"
            className="max-w-64"
            value={collectedAt}
            onChange={(e) => setCollectedAt(e.target.value)}
          />
          {errors.collectedAt ? <FieldError>{errors.collectedAt}</FieldError> : null}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('minC', 'Initial curing minimum', minC, setMinC, '°C')}
          {field('maxC', 'Initial curing maximum', maxC, setMaxC, '°C')}
        </div>
        <p className="-mt-3 text-[13px] text-muted-foreground">
          {data.receiving.currentCuringRange
            ? `Checked against ${data.receiving.currentCuringRange.specification} ${data.receiving.currentCuringRange.edition}; out of range is flagged for the reviewers and blocks nothing here.`
            : 'No curing range is set yet, so the readings are stored unchecked.'}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('box', 'Curing box (optional)', box, setBox)}
          {field('where', 'Location (optional)', where, setWhere)}
        </div>
        {failure ? (
          <p role="alert" className="text-sm text-destructive-text">
            {failure}
          </p>
        ) : null}
      </form>
      <SheetFooter className="flex-row justify-end border-t">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={busy || chosen.length === 0}>
          {busy
            ? 'Saving…'
            : `Mark ${chosen.length} ${chosen.length === 1 ? 'specimen' : 'specimens'} picked up`}
        </Button>
      </SheetFooter>
    </>
  );
}
