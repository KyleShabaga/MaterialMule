import {
  type ConcreteMixDetail,
  type ConcreteMixRevision,
  type ConcreteMixSpec,
} from '@materialmule/shared';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { BandedCard, ConfirmDialog, ErrorState, StatusBadge } from '../../components/ui';
import { shortDateTime } from '../../dashboard/format';
import {
  ConcreteApiError,
  approveMix,
  concreteProblem,
  fetchMix,
  fetchPropagation,
  updateMix,
} from './api';
import { MixForm, type MixSpecInput } from './MixForm';
import { DiscardDraftDialog, SupplierLink } from './MixManage';
import {
  MIX_STATUS,
  admixturesText,
  agesText,
  airText,
  slumpText,
  strengthText,
  value,
} from './mix-format';
import { ConcreteFrame } from './ProjectConcretePage';
import { concreteTabPath, mixPath, propagationPath } from './paths';
import { useLoad } from './useLoad';

// MM-V2-C30: one mix with its full specification (project spec, supplier-ticket defaults,
// admixtures, test ages), the mix-design document place, every revision and the change history.
// The Lead edits (D14: an approved mix gets a draft revision) and approves; after an approval the
// Lead reviews which existing records the new revision would change (propagation review).
// MM-V2-C37's discard draft and listed-supplier link live here too (consolidated from C37's
// separate mixes screen).

const ACTION_LABEL: Record<string, string> = {
  'concrete_mix.created': 'Created',
  'concrete_mix.copied': 'Copied from another project',
  'concrete_mix.draft_edited': 'Draft edited',
  'concrete_mix.revision_drafted': 'Revision drafted',
  'concrete_mix.approved': 'Approved',
  'concrete_mix.draft_discarded': 'Draft discarded',
  'concrete_mix.supplier_linked': 'Listed supplier changed',
  'concrete_mix.propagation_applied': 'Records updated from the mix',
};

function SpecFacts({ spec }: { spec: ConcreteMixSpec }) {
  const t = spec.ticketDefaults;
  return (
    <dl className="concrete-facts mix-facts">
      <div>
        <dt>Plants</dt>
        <dd>{spec.plantNames.length > 0 ? spec.plantNames.join(', ') : '—'}</dd>
      </div>
      <div>
        <dt>Specified strength</dt>
        <dd>{strengthText(spec)}</dd>
      </div>
      <div>
        <dt>Slump</dt>
        <dd>{slumpText(spec)}</dd>
      </div>
      <div>
        <dt>Air</dt>
        <dd>{airText(spec)}</dd>
      </div>
      <div>
        <dt>Max aggregate</dt>
        <dd>{value(spec.maxAggregateSizeMm, ' mm')}</dd>
      </div>
      <div>
        <dt>Cement type</dt>
        <dd>{spec.cementType ?? '—'}</dd>
      </div>
      <div>
        <dt>Admixtures (project specification)</dt>
        <dd>{admixturesText(spec.specAdmixtures)}</dd>
      </div>
      <div>
        <dt>Test ages</dt>
        <dd>{agesText(spec.testAges)}</dd>
      </div>
      <div className="mix-facts-wide">
        <dt>Supplier-ticket defaults</dt>
        <dd>
          Strength {value(t.specifiedStrengthMpa, ' MPa')} · Slump {slumpText(t)} · Air {airText(t)}{' '}
          · Aggregate {value(t.maxAggregateSizeMm, ' mm')} · Cement {t.cementType ?? '—'} ·
          Admixtures {admixturesText(t.admixtures)}
        </dd>
      </div>
    </dl>
  );
}

function revisionTitle(revision: ConcreteMixRevision) {
  const state =
    revision.state === 'draft'
      ? 'draft'
      : revision.state === 'approved'
        ? 'in effect'
        : 'superseded';
  return `Revision ${revision.revisionNumber} (${state})`;
}

export function MixDetailPage() {
  const { projectId = '', mixId = '' } = useParams();
  return (
    <ConcreteFrame
      projectId={projectId}
      title="Mix"
      back={<Link to={concreteTabPath(projectId, 'mixes')}>← Back to Mixes</Link>}
    >
      {() => <MixDetail projectId={projectId} mixId={mixId} />}
    </ConcreteFrame>
  );
}

function MixDetail({ projectId, mixId }: { projectId: string; mixId: string }) {
  const navigate = useNavigate();
  const { load, reload, replace } = useLoad(`mix|${mixId}`, () => fetchMix(mixId));
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (load.state === 'loading') return <p role="status">Loading…</p>;
  if (load.state === 'error') {
    return <ErrorState message={concreteProblem(load.error)} onRetry={reload} />;
  }
  const mix = load.data;
  // The mix is loaded by ID alone: under another project's address it goes to its own project, so
  // its content and controls never show under the wrong project header.
  if (mix.projectId !== projectId) return <Navigate replace to={mixPath(mix.projectId, mix.id)} />;
  const status = MIX_STATUS[mix.status];
  const working = mix.draftRevision ?? mix.effectiveRevision;
  const stale = (caught: unknown) => {
    if (caught instanceof ConcreteApiError && caught.code === 'version_conflict') {
      const current = (caught.body as { current?: ConcreteMixDetail } | null)?.current;
      if (current) replace(current);
    }
    setError(concreteProblem(caught));
  };

  function managed(next: ConcreteMixDetail, message: string) {
    replace(next);
    setDiscarding(false);
    setError(null);
    setNotice(message);
  }

  function save(spec: Partial<MixSpecInput>) {
    setBusy(true);
    setError(null);
    updateMix(mix.id, { idempotencyKey: crypto.randomUUID(), version: mix.version, spec })
      .then((next) => {
        replace(next);
        setEditing(false);
        setNotice(
          mix.effectiveRevision
            ? `Saved as draft revision ${next.draftRevision?.revisionNumber ?? ''}. Revision ${mix.effectiveRevision.revisionNumber} stays in effect until you approve it.`
            : 'Draft saved.',
        );
      })
      .catch(stale)
      .finally(() => setBusy(false));
  }

  function approve() {
    const draft = mix.draftRevision;
    if (!draft) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    approveMix(mix.id, {
      idempotencyKey: crypto.randomUUID(),
      version: mix.version,
      revisionId: draft.id,
    })
      .then(async (next) => {
        replace(next);
        setNotice(`Revision ${draft.revisionNumber} approved.`);
        // Records made from earlier revisions: the Lead decides which change (propagation).
        const preview = await fetchPropagation(next.id).catch(() => null);
        if (preview && preview.items.length > 0) navigate(propagationPath(projectId, next.id));
      })
      .catch(stale)
      .finally(() => setBusy(false));
  }

  return (
    <>
      <div className="mix-heading">
        <h2>
          {mix.supplierName} · {mix.mixNumber}
        </h2>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>
      {mix.copiedFrom ? (
        <p className="field-hint">
          Copied from {mix.copiedFrom.projectNumber} {mix.copiedFrom.supplierName}{' '}
          {mix.copiedFrom.mixNumber}, revision {mix.copiedFrom.revisionNumber}.
        </p>
      ) : null}
      <p className="notice notice-success" role="status">
        {notice}
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {mix.canManage || mix.canApprove ? (
        !editing ? (
          <div className="page-actions mix-actions">
            {mix.canManage ? (
              <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                {mix.draftRevision ? 'Edit draft' : 'Edit (makes a draft revision)'}
              </button>
            ) : null}
            {mix.canApprove && mix.draftRevision ? (
              <button
                type="button"
                className="primary"
                disabled={busy || mix.draftRevision.missingForApproval.length > 0}
                onClick={() => setConfirming(true)}
              >
                Approve revision {mix.draftRevision.revisionNumber}
              </button>
            ) : null}
            {mix.canApprove && mix.effectiveRevision ? (
              <Link className="button" to={propagationPath(projectId, mix.id)}>
                Review affected records
              </Link>
            ) : null}
            {mix.canManage && mix.draftRevision && mix.effectiveRevision ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => setDiscarding(true)}
              >
                Discard draft revision {mix.draftRevision.revisionNumber}
              </button>
            ) : null}
          </div>
        ) : null
      ) : (
        <p className="field-hint concrete-lead-only">
          Only the project’s Lead Project Engineer can edit or approve this mix.
        </p>
      )}
      {mix.draftRevision && mix.draftRevision.missingForApproval.length > 0 ? (
        <p className="field-hint">
          Before approval, fill in: {mix.draftRevision.missingForApproval.join(', ')}.
        </p>
      ) : null}

      {mix.canManage && mix.draftRevision && !mix.effectiveRevision ? (
        <p className="field-hint">
          This mix has no approved revision yet, so its draft can&rsquo;t be discarded.
        </p>
      ) : null}
      <SupplierLink key={mix.version} mix={mix} onDone={managed} />

      {editing && working ? (
        <BandedCard title={mix.draftRevision ? 'Edit draft' : 'Edit as a new revision'}>
          <MixForm
            initial={working.spec}
            title="Edit mix"
            submitLabel="Save draft"
            busy={busy}
            error={error}
            onCancel={() => setEditing(false)}
            onSubmit={save}
          />
        </BandedCard>
      ) : null}

      <div className="mix-revisions">
        {mix.effectiveRevision ? (
          <BandedCard
            title={revisionTitle(mix.effectiveRevision)}
            subtitle={
              mix.effectiveRevision.approvedBy && mix.effectiveRevision.approvedAt
                ? `Approved by ${mix.effectiveRevision.approvedBy.name} ${shortDateTime(mix.effectiveRevision.approvedAt)}`
                : undefined
            }
          >
            <SpecFacts spec={mix.effectiveRevision.spec} />
          </BandedCard>
        ) : null}
        {mix.draftRevision ? (
          <BandedCard
            title={revisionTitle(mix.draftRevision)}
            subtitle="Not in effect until the Lead approves it"
            tone="attention"
          >
            <SpecFacts spec={mix.draftRevision.spec} />
          </BandedCard>
        ) : null}
      </div>

      <BandedCard title="Mix design document">
        <p className="field-hint">
          Attaching the supplier’s mix design document arrives with file storage (C15).
        </p>
      </BandedCard>

      <BandedCard title="History" subtitle={`${mix.historyTotal} changes`}>
        <ol className="mix-history">
          {mix.history.map((event) => (
            <li key={event.id}>
              <strong>{ACTION_LABEL[event.action] ?? event.action}</strong>{' '}
              <span className="muted">
                {shortDateTime(event.occurredAt)}
                {event.changedBy ? ` · ${event.changedBy.name}` : ''}
              </span>
              {event.action === 'concrete_mix.propagation_applied' ? (
                <p>
                  {event.after.scope === 'approve_all' ? 'Approve all' : 'Chosen records'} from
                  revision {String(event.after.toRevision)}:{' '}
                  {Array.isArray(event.after.applied) ? event.after.applied.join('; ') : ''}
                </p>
              ) : null}
              {event.note ? <p className="muted">Note: {event.note}</p> : null}
            </li>
          ))}
        </ol>
        {mix.revisions.length > 0 ? (
          <p className="field-hint">
            Revisions: {mix.revisions.map((r) => `${r.revisionNumber} (${r.state})`).join(', ')}
          </p>
        ) : null}
      </BandedCard>

      {discarding && mix.draftRevision && mix.effectiveRevision ? (
        <DiscardDraftDialog mix={mix} onDone={managed} onCancel={() => setDiscarding(false)} />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Approve revision ${mix.draftRevision?.revisionNumber ?? ''}?`}
        confirmLabel="Approve"
        onConfirm={approve}
        onCancel={() => setConfirming(false)}
      >
        <p>
          New field reports and specimen sets will use this revision. Existing records keep their
          values until you review them on the next screen.
        </p>
      </ConfirmDialog>
    </>
  );
}
