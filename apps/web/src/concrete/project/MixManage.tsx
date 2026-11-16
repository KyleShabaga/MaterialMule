import type { ConcreteMixDetail, ConcreteSupplier } from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fetchSuppliers } from '../../settings/reference/api';
import { concreteProblem, discardMixDraft, linkMixSupplier } from './api';

// MM-V2-C37 on the mix page: the Lead discards the open draft revision of an approved mix (the
// approved revision stays in effect, unchanged; audited) and links a listed supplier. The server
// enforces both (`concrete_mix.manage`).

const NOT_LINKED = 'none';

export function DiscardDraftDialog({
  mix,
  onDone,
  onCancel,
}: {
  mix: ConcreteMixDetail;
  onDone: (next: ConcreteMixDetail, message: string) => void;
  onCancel: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const draft = mix.draftRevision!;
  const approved = mix.effectiveRevision!;

  function confirm() {
    setBusy(true);
    setError(null);
    discardMixDraft(mix.id, {
      idempotencyKey: key,
      version: mix.version,
      revisionId: draft.id,
      note: note.trim() === '' ? null : note,
    })
      .then((next) =>
        onDone(
          next,
          `Draft revision ${draft.revisionNumber} of ${approved.spec.mixNumber} discarded. Revision ${approved.revisionNumber} stays in effect.`,
        ),
      )
      .catch((caught: unknown) => setError(concreteProblem(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard draft revision {draft.revisionNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            The approved revision {approved.revisionNumber} of {approved.spec.supplierName}{' '}
            {approved.spec.mixNumber} stays in effect, unchanged. The draft is kept in the mix
            history as discarded and can&rsquo;t be edited or approved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={noteId}>Note (optional)</FieldLabel>
          <Textarea
            id={noteId}
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? 'Discarding…' : 'Discard draft'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The mix's listed-supplier link: read for everyone, a picker for the Lead. */
export function SupplierLink({
  mix,
  onDone,
}: {
  mix: ConcreteMixDetail;
  onDone: (next: ConcreteMixDetail, message: string) => void;
}) {
  const selectId = useId();
  const [suppliers, setSuppliers] = useState<ConcreteSupplier[] | null>(null);
  const [value, setValue] = useState(mix.supplier?.id ?? NOT_LINKED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = mix.supplier
    ? `${mix.supplier.name}${mix.supplier.active ? '' : ' (inactive)'}`
    : 'Not linked';

  useEffect(() => {
    if (!mix.canManage) return;
    let live = true;
    void fetchSuppliers(true).then((result) => {
      if (live) setSuppliers(result.ok ? result.data.items : []);
    });
    return () => {
      live = false;
    };
  }, [mix.canManage]);

  if (!mix.canManage) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <dt className="text-muted-foreground">Listed supplier</dt>
        <dd>{current}</dd>
      </dl>
    );
  }
  const options = (suppliers ?? []).filter((s) => s.active || s.id === mix.supplier?.id);
  const changed = value !== (mix.supplier?.id ?? NOT_LINKED);

  function save() {
    setBusy(true);
    setError(null);
    linkMixSupplier(mix.id, {
      idempotencyKey: crypto.randomUUID(),
      version: mix.version,
      supplierId: value === NOT_LINKED ? null : value,
    })
      .then((next) =>
        onDone(
          next,
          next.supplier
            ? `${mix.mixNumber} linked to ${next.supplier.name}.`
            : `${mix.mixNumber} unlinked.`,
        ),
      )
      .catch((caught: unknown) => setError(concreteProblem(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={selectId}>Listed supplier</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={value} disabled={suppliers === null} onValueChange={setValue}>
          <SelectTrigger id={selectId} className="min-w-48 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOT_LINKED}>Not linked</SelectItem>
            {mix.supplier && suppliers === null ? (
              <SelectItem value={mix.supplier.id}>{current}</SelectItem>
            ) : null}
            {options.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
                {s.active ? '' : ' (inactive)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" disabled={!changed || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save link'}
        </Button>
      </div>
      <FieldDescription>
        The supplier and mix names on the specification stay as typed; the link is the mix&rsquo;s,
        not a revision&rsquo;s.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
