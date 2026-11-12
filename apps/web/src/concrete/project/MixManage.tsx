import type { ConcreteMixDetail, ConcreteSupplier } from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '../../components/app-ui';
import { fetchSuppliers } from '../../settings/reference/api';
import { concreteProblem, discardMixDraft, linkMixSupplier } from './api';

// MM-V2-C37 on the C30 mix detail page: the Lead discards the open draft revision of an approved
// mix (the approved revision stays in effect, unchanged; audited) and links a listed supplier.
// The server enforces both (`concrete_mix.manage`).

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
    <ConfirmDialog
      open
      danger
      title={`Discard draft revision ${draft.revisionNumber}?`}
      confirmLabel={busy ? 'Discarding…' : 'Discard draft'}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <p>
        The approved revision {approved.revisionNumber} of {approved.spec.supplierName}{' '}
        {approved.spec.mixNumber} stays in effect, unchanged. The draft is kept in the mix history
        as discarded and can&rsquo;t be edited or approved.
      </p>
      <div className="form-field">
        <label htmlFor={noteId}>Note (optional)</label>
        <textarea
          id={noteId}
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
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
  const [value, setValue] = useState(mix.supplier?.id ?? '');
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
      <p>
        <strong>Listed supplier:</strong> {current}
      </p>
    );
  }
  const options = (suppliers ?? []).filter((s) => s.active || s.id === mix.supplier?.id);
  const changed = value !== (mix.supplier?.id ?? '');

  function save() {
    setBusy(true);
    setError(null);
    linkMixSupplier(mix.id, {
      idempotencyKey: crypto.randomUUID(),
      version: mix.version,
      supplierId: value === '' ? null : value,
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
    <div className="form-field">
      <label htmlFor={selectId}>Listed supplier</label>
      <div className="form-actions">
        <select
          id={selectId}
          value={value}
          disabled={suppliers === null}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">Not linked</option>
          {mix.supplier && suppliers === null ? (
            <option value={mix.supplier.id}>{current}</option>
          ) : null}
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
        <button type="button" disabled={!changed || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save link'}
        </button>
      </div>
      <p className="field-hint">
        The supplier and mix names on the specification stay as typed; the link is the mix&rsquo;s,
        not a revision&rsquo;s.
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
