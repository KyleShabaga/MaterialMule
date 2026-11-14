import type { RetentionExtension, RetentionHold } from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { formatExpiry } from '../lib/format';
import { postRetention } from './api';

// Shared MM-T29 pieces (Strata styles, STRATA-90): the hold/extension form (decide directly, or
// request for people without authority) and the history list with Release. Every rule is checked
// again by the server.

function who(person: { initials: string | null; name: string }) {
  return person.initials ? `${person.initials} · ${person.name}` : person.name;
}

function Choice({ id, value, label }: { id: string; value: string; label: string }) {
  return (
    <Field orientation="horizontal">
      <RadioGroupItem value={value} id={id} />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
    </Field>
  );
}

export function RetentionForm({
  projectId,
  unitIds,
  mode,
  onDone,
}: {
  projectId: string;
  /** Selected units; omitted for the whole project. */
  unitIds?: string[];
  mode: 'manage' | 'request';
  onDone: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<'hold' | 'extension'>('hold');
  const [amount, setAmount] = useState<'date' | 'months'>('date');
  const [retainUntil, setRetainUntil] = useState('');
  const [months, setMonths] = useState('12');
  const [holdUntil, setHoldUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const scope = unitIds ? { scope: 'units', unitIds } : { scope: 'project' };
    const extension =
      kind === 'extension'
        ? amount === 'date'
          ? { retainUntil }
          : { extendMonths: Number(months) }
        : holdUntil
          ? { holdUntil }
          : {};
    const outcome =
      mode === 'request'
        ? await postRetention('/api/retention/requests', {
            kind,
            projectId,
            ...scope,
            ...extension,
            reason,
            idempotencyKey: key,
          })
        : await postRetention(
            kind === 'hold' ? '/api/retention/holds' : '/api/retention/extensions',
            {
              projectId,
              ...scope,
              ...extension,
              reason,
              idempotencyKey: key,
            },
          );
    setBusy(false);
    if (outcome.ok) {
      setReason('');
      setKey(crypto.randomUUID());
      onDone();
    } else {
      setError(outcome.message);
    }
  }

  const target = unitIds ? 'this unit' : 'the whole project (current and future units)';
  return (
    <form
      className="flex flex-col gap-4 rounded-md border p-4"
      aria-label={mode === 'request' ? 'Request a hold or extension' : 'Place a hold or extension'}
      onSubmit={(event) => void submit(event)}
    >
      <FieldSet>
        <FieldLegend variant="label">{mode === 'request' ? 'Ask for' : 'Add'}</FieldLegend>
        <RadioGroup value={kind} onValueChange={(next) => setKind(next as 'hold' | 'extension')}>
          <Choice id={`${id}-hold`} value="hold" label={`Hold on ${target}`} />
          <Choice id={`${id}-extension`} value="extension" label={`Extension for ${target}`} />
        </RadioGroup>
      </FieldSet>
      {kind === 'extension' ? (
        <FieldSet>
          <RadioGroup
            value={amount}
            onValueChange={(next) => setAmount(next as 'date' | 'months')}
            aria-label="Extend by"
          >
            <Choice id={`${id}-date`} value="date" label="Retain until" />
            <Input
              type="date"
              aria-label="New retain-until date"
              className="w-44 font-mono"
              value={retainUntil}
              disabled={amount !== 'date'}
              onChange={(event) => setRetainUntil(event.target.value)}
            />
            <Choice id={`${id}-months`} value="months" label="Add months to the minimum" />
            <Input
              type="number"
              min={1}
              max={600}
              aria-label="Months to add"
              className="w-28 font-mono"
              value={months}
              disabled={amount !== 'months'}
              onChange={(event) => setMonths(event.target.value)}
            />
          </RadioGroup>
          <FieldDescription>An extension can only make retain-until later.</FieldDescription>
        </FieldSet>
      ) : (
        <Field>
          <FieldLabel htmlFor={`${id}-hold-until`}>Hold until (optional)</FieldLabel>
          <Input
            id={`${id}-hold-until`}
            type="date"
            className="w-44 font-mono"
            value={holdUntil}
            onChange={(event) => setHoldUntil(event.target.value)}
          />
          <FieldDescription>
            A reminder date. The hold stays until someone releases it.
          </FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-reason`}>Reason (required)</FieldLabel>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !reason.trim()}>
          {mode === 'request' ? 'Send request' : kind === 'hold' ? 'Place hold' : 'Set extension'}
        </Button>
        {mode === 'request' ? (
          <p className="text-muted-foreground text-[13px]">
            The project’s Lead Project Engineer and the Lab Managers decide; nothing changes until
            one of them does.
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function RetentionHistory({
  holds,
  extensions,
  canManage,
  onChanged,
}: {
  holds: RetentionHold[];
  extensions: RetentionExtension[];
  canManage: boolean;
  onChanged: () => void;
}) {
  if (holds.length === 0 && extensions.length === 0) {
    return <p className="text-muted-foreground text-sm">No holds or extensions.</p>;
  }
  return (
    <ul className="flex flex-col divide-y">
      {holds.map((item) => (
        <DecisionRow
          key={item.id}
          kind="holds"
          item={item}
          title={`Hold: ${item.reason}`}
          by={`Placed by ${who(item.placedBy)} · ${formatExpiry(item.placedAt)}${
            item.holdUntil ? ` · until ${item.holdUntil}` : ''
          }`}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
      {extensions.map((item) => (
        <DecisionRow
          key={item.id}
          kind="extensions"
          item={item}
          title={`Extension ${item.retainUntil ? `to ${item.retainUntil}` : `+${item.extendMonths} months`}: ${item.reason}`}
          by={`Set by ${who(item.setBy)} · ${formatExpiry(item.setAt)}`}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function DecisionRow({
  kind,
  item,
  title,
  by,
  canManage,
  onChanged,
}: {
  kind: 'holds' | 'extensions';
  item: RetentionHold | RetentionExtension;
  title: string;
  by: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const id = useId();
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const scope =
    item.scope === 'project'
      ? 'Whole project'
      : item.units.map((unit) => unit.readableId).join(', ');

  async function release(event: FormEvent) {
    event.preventDefault();
    const outcome = await postRetention(`/api/retention/${kind}/${item.id}/release`, {
      reason,
      version: item.version,
      idempotencyKey: key,
    });
    if (outcome.ok) {
      // MTR-83: the item reloads as released; its form closes rather than lingering under it.
      setReleasing(false);
      setReason('');
      onChanged();
    } else {
      setError(outcome.message);
      onChanged();
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={title}>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{item.active ? 'Active' : 'Released'}</Badge>
        <strong className="font-semibold">{title}</strong>
      </p>
      <p className="text-muted-foreground text-[13px]">
        {scope} · {by}
        {item.releasedBy && item.releasedAt
          ? ` · Released by ${who(item.releasedBy)} · ${formatExpiry(item.releasedAt)}: ${item.releaseReason}`
          : ''}
      </p>
      {canManage && item.active && !releasing ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setReleasing(true)}
        >
          Release
        </Button>
      ) : null}
      {releasing && item.active ? (
        <form
          aria-label="Release"
          className="flex flex-col gap-3"
          onSubmit={(event) => void release(event)}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-release`}>Reason for releasing (required)</FieldLabel>
            <Textarea
              id={`${id}-release`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setReleasing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!reason.trim()}>
              Release
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
