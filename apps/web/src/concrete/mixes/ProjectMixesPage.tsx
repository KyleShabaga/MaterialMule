import type { ConcreteMixList, ConcreteMixStatus, ConcreteSupplier } from '@materialmule/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusBadge,
} from '../../components/ui';
import { fetchSuppliers } from '../../settings/reference/api';
import '../../settings/reference/reference-settings.css';
import { discardMixDraft, fetchProjectMixes, linkMixSupplier } from './api';

// A project's concrete mixes (MM-V2-C03 registry; MM-V2-C37 screen). Everyone with the project
// reads them. The project's Lead Project Engineer may discard the open draft revision of an
// approved mix (the approved revision stays in effect and unchanged; audited) and link a listed
// supplier. The server enforces both.

type Mix = ConcreteMixList['items'][number];
type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: ConcreteMixList; suppliers: ConcreteSupplier[] };

const STATUS: Record<ConcreteMixStatus, { label: string; tone: 'success' | 'warning' | 'info' }> = {
  unapproved: { label: 'Unapproved', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  revision_pending: { label: 'Revision pending', tone: 'info' },
};

const strength = (mpa: number | null) => (mpa === null ? 'not entered' : `${mpa} MPa`);

function DiscardDialog({
  mix,
  onDone,
  onCancel,
}: {
  mix: Mix;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const draft = mix.draftRevision!;
  const approved = mix.effectiveRevision!;

  async function confirm() {
    setBusy(true);
    setError(null);
    const result = await discardMixDraft(mix, note, key);
    setBusy(false);
    if (result.ok) {
      onDone(
        `Draft revision ${draft.revisionNumber} of ${approved.spec.mixNumber} discarded. Revision ${approved.revisionNumber} stays in effect.`,
      );
    } else setError(result.message);
  }

  return (
    <ConfirmDialog
      open
      danger
      title={`Discard draft revision ${draft.revisionNumber}?`}
      confirmLabel={busy ? 'Discarding…' : 'Discard draft'}
      onConfirm={() => void confirm()}
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

function SupplierLink({
  mix,
  suppliers,
  onDone,
}: {
  mix: Mix;
  suppliers: ConcreteSupplier[];
  onDone: (message: string) => void;
}) {
  const selectId = useId();
  const [value, setValue] = useState(mix.supplier?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = suppliers.filter((s) => s.active || s.id === mix.supplier?.id);
  const changed = value !== (mix.supplier?.id ?? '');

  async function save() {
    setBusy(true);
    setError(null);
    const result = await linkMixSupplier(mix, value === '' ? null : value, crypto.randomUUID());
    setBusy(false);
    if (result.ok) {
      onDone(
        result.data.supplier
          ? `${mix.mixNumber} linked to ${result.data.supplier.name}.`
          : `${mix.mixNumber} unlinked.`,
      );
    } else setError(result.message);
  }

  return (
    <div className="form-field">
      <label htmlFor={selectId}>Listed supplier</label>
      <div className="form-actions">
        <select id={selectId} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Not linked</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
        <button type="button" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save link'}
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ProjectMixesPage() {
  const { projectId = '' } = useParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void Promise.all([fetchProjectMixes(projectId), fetchSuppliers(true)]).then(
      ([mixes, suppliers]) => {
        if (!live) return;
        setLoad(
          mixes.ok
            ? {
                state: 'ready',
                data: mixes.data,
                suppliers: suppliers.ok ? suppliers.data.items : [],
              }
            : { state: 'error', message: mixes.message },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, attempt]);

  const back = <Link to={`/projects/${encodeURIComponent(projectId)}`}>← Back to the project</Link>;
  if (load.state === 'loading') {
    return (
      <>
        <PageHeader title="Concrete mixes" />
        <p aria-busy="true">Loading mixes…</p>
      </>
    );
  }
  if (load.state === 'error') {
    return (
      <>
        <PageHeader title="Concrete mixes" />
        {back}
        <ErrorState
          message={load.message}
          onRetry={() => {
            setLoad({ state: 'loading' });
            reload();
          }}
        />
      </>
    );
  }
  const { data, suppliers } = load;
  const done = (message: string) => {
    setDiscarding(null);
    setNotice(message);
    reload();
  };
  const toDiscard = data.items.find((mix) => mix.id === discarding) ?? null;

  return (
    <>
      <PageHeader title="Concrete mixes" />
      {back}
      <p role="status" className="field-hint">
        {notice ?? ''}
      </p>
      {data.canManage ? null : (
        <p className="field-hint">
          Only the project&rsquo;s Lead Project Engineer can change its mixes.
        </p>
      )}
      {data.items.length === 0 ? (
        <EmptyState>This project has no concrete mixes yet.</EmptyState>
      ) : null}
      {data.items.map((mix) => {
        const status = STATUS[mix.status];
        const canDiscard = data.canManage && mix.draftRevision && mix.effectiveRevision;
        return (
          <article
            key={mix.id}
            className="mix-card"
            aria-label={`${mix.supplierName} ${mix.mixNumber}`}
          >
            <header>
              <h3>
                {mix.supplierName} · {mix.mixNumber}
              </h3>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </header>
            <dl>
              <dt>Listed supplier</dt>
              <dd>
                {mix.supplier
                  ? `${mix.supplier.name}${mix.supplier.active ? '' : ' (inactive)'}`
                  : 'Not linked'}
              </dd>
              <dt>In effect</dt>
              <dd>
                {mix.effectiveRevision
                  ? `Revision ${mix.effectiveRevision.revisionNumber}, ${strength(mix.effectiveRevision.spec.specifiedStrengthMpa)}`
                  : 'No approved revision yet'}
              </dd>
              <dt>Draft</dt>
              <dd>
                {mix.draftRevision
                  ? `Revision ${mix.draftRevision.revisionNumber}, ${strength(mix.draftRevision.spec.specifiedStrengthMpa)}`
                  : 'None'}
              </dd>
            </dl>
            {data.canManage ? (
              <SupplierLink key={mix.version} mix={mix} suppliers={suppliers} onDone={done} />
            ) : null}
            {canDiscard ? (
              <div className="form-actions">
                <button type="button" className="danger" onClick={() => setDiscarding(mix.id)}>
                  Discard draft revision {mix.draftRevision!.revisionNumber}
                </button>
              </div>
            ) : null}
            {data.canManage && mix.draftRevision && !mix.effectiveRevision ? (
              <p className="field-hint">
                This mix has no approved revision yet, so its draft can&rsquo;t be discarded.
              </p>
            ) : null}
          </article>
        );
      })}
      {toDiscard ? (
        <DiscardDialog mix={toDiscard} onDone={done} onCancel={() => setDiscarding(null)} />
      ) : null}
    </>
  );
}
