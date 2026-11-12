import {
  type ConcreteMixDetail,
  type ConcreteMixRevision,
  type ConcreteMixSpec,
  type ProjectDetail,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import {
  BandedCard,
  ConfirmDialog,
  ErrorState,
  PageHeader,
  SectionHead,
  SidePanel,
  StatusBadge,
} from '../../components/app-ui';
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
// Field Ledger (canvas "ConcreteMix"): the approved and draft revisions side by side, the draft's
// changed values tinted and marked "Changed", then the history; the Lead's actions at the side.

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

interface SpecRow {
  key: string;
  label: string;
  value: string;
}

/** One revision's specification as labelled rows, in the same order for every revision. */
function specRows(spec: ConcreteMixSpec): SpecRow[] {
  const t = spec.ticketDefaults;
  return [
    { key: 'name', label: 'Supplier and mix', value: `${spec.supplierName} ${spec.mixNumber}` },
    {
      key: 'plants',
      label: 'Plants',
      value: spec.plantNames.length > 0 ? spec.plantNames.join(', ') : '—',
    },
    { key: 'strength', label: 'Specified strength', value: strengthText(spec) },
    { key: 'slump', label: 'Slump', value: slumpText(spec) },
    { key: 'air', label: 'Air', value: airText(spec) },
    { key: 'aggregate', label: 'Max aggregate', value: value(spec.maxAggregateSizeMm, ' mm') },
    { key: 'cement', label: 'Cement type', value: spec.cementType ?? '—' },
    {
      key: 'admixtures',
      label: 'Admixtures (project specification)',
      value: admixturesText(spec.specAdmixtures),
    },
    { key: 'ages', label: 'Test ages', value: agesText(spec.testAges) },
    {
      key: 'ticket',
      label: 'Supplier-ticket defaults',
      value: `Strength ${value(t.specifiedStrengthMpa, ' MPa')} · Slump ${slumpText(t)} · Air ${airText(t)} · Aggregate ${value(t.maxAggregateSizeMm, ' mm')} · Cement ${t.cementType ?? '—'} · Admixtures ${admixturesText(t.admixtures)}`,
    },
  ];
}

/** The rows whose value differs between the revision in effect and the draft. */
function changedRows(approved: ConcreteMixSpec, draft: ConcreteMixSpec): SpecRow[] {
  const before = new Map(specRows(approved).map((row) => [row.key, row.value]));
  return specRows(draft).filter((row) => before.get(row.key) !== row.value);
}

function SpecFacts({ spec, changed }: { spec: ConcreteMixSpec; changed?: Set<string> }) {
  return (
    <dl className="mix-spec">
      {specRows(spec).map((row) => {
        const isChanged = changed?.has(row.key) ?? false;
        return (
          <div key={row.key} className={isChanged ? 'mix-spec-row is-changed' : 'mix-spec-row'}>
            <dt>{row.label}</dt>
            <dd>
              <span className="mono">{row.value}</span>
              {isChanged ? <StatusBadge tone="flag">Changed</StatusBadge> : null}
            </dd>
          </div>
        );
      })}
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
      {(project) => <MixDetail project={project} projectId={projectId} mixId={mixId} />}
    </ConcreteFrame>
  );
}

function MixDetail({
  project,
  projectId,
  mixId,
}: {
  project: ProjectDetail;
  projectId: string;
  mixId: string;
}) {
  const navigate = useNavigate();
  const historyId = useId();
  const specId = useId();
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
  const changes =
    mix.effectiveRevision && mix.draftRevision
      ? changedRows(mix.effectiveRevision.spec, mix.draftRevision.spec)
      : null;
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

  const canAct = mix.canManage || mix.canApprove;

  return (
    <>
      <div className="mix-heading">
        <p className="concrete-record-meta">
          {mix.projectNumber} · {project.name}
        </p>
        <div className="mix-heading-title">
          <PageHeader title={`${mix.supplierName} · ${mix.mixNumber}`} documentTitle={false} />
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
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

      <div className="concrete-split">
        <div className="concrete-split-main">
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

          <section aria-labelledby={specId}>
            <SectionHead
              id={specId}
              title="Specification"
              meta={changes ? 'Changes in the draft are marked' : undefined}
            />
            <div className="mix-revisions">
              {mix.effectiveRevision ? (
                <BandedCard
                  headingLevel={3}
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
                  headingLevel={3}
                  title={revisionTitle(mix.draftRevision)}
                  subtitle="Not in effect until the Lead approves it"
                  tone="attention"
                >
                  <SpecFacts
                    spec={mix.draftRevision.spec}
                    changed={changes ? new Set(changes.map((row) => row.key)) : undefined}
                  />
                </BandedCard>
              ) : null}
            </div>
            {mix.effectiveRevision && mix.draftRevision ? (
              <p className="field-hint">
                Revision {mix.effectiveRevision.revisionNumber} stays in effect on new records until
                revision {mix.draftRevision.revisionNumber} is approved.
              </p>
            ) : null}
          </section>

          <section aria-labelledby={historyId}>
            <SectionHead id={historyId} title="History" meta={`${mix.historyTotal} changes`} />
            <ol className="mix-history">
              {mix.history.map((event) => (
                <li key={event.id}>
                  <span className="mono mix-history-when">{shortDateTime(event.occurredAt)}</span>
                  <div>
                    <strong>{ACTION_LABEL[event.action] ?? event.action}</strong>
                    {event.changedBy ? (
                      <span className="mix-history-who"> · {event.changedBy.name}</span>
                    ) : null}
                    {event.action === 'concrete_mix.propagation_applied' ? (
                      <p>
                        {event.after.scope === 'approve_all' ? 'Approve all' : 'Chosen records'}{' '}
                        from revision {String(event.after.toRevision)}:{' '}
                        {Array.isArray(event.after.applied) ? event.after.applied.join('; ') : ''}
                      </p>
                    ) : null}
                    {event.note ? <p className="muted">Note: {event.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
            {mix.revisions.length > 0 ? (
              <p className="field-hint">
                Revisions: {mix.revisions.map((r) => `${r.revisionNumber} (${r.state})`).join(', ')}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="concrete-split-aside" aria-label="Mix actions">
          <SidePanel
            title={
              mix.draftRevision
                ? `Draft revision ${mix.draftRevision.revisionNumber}`
                : 'Change this mix'
            }
          >
            {canAct ? (
              <div className="concrete-panel-stack">
                {changes ? (
                  <p>
                    {changes.length === 0
                      ? `The draft has the same values as revision ${mix.effectiveRevision!.revisionNumber}.`
                      : `${changes.length} ${changes.length === 1 ? 'value changes' : 'values change'}: ${changes.map((row) => row.label.toLowerCase()).join(', ')}.`}
                  </p>
                ) : null}
                {mix.draftRevision && mix.draftRevision.missingForApproval.length > 0 ? (
                  <p className="field-hint">
                    Before approval, fill in: {mix.draftRevision.missingForApproval.join(', ')}.
                  </p>
                ) : null}
                {!editing ? (
                  <div className="concrete-panel-actions">
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
                    {mix.canManage ? (
                      <button type="button" onClick={() => setEditing(true)} disabled={busy}>
                        {mix.draftRevision ? 'Edit draft' : 'Edit (makes a draft revision)'}
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
                ) : null}
                {mix.canManage && mix.draftRevision && !mix.effectiveRevision ? (
                  <p className="field-hint">
                    This mix has no approved revision yet, so its draft can&rsquo;t be discarded.
                  </p>
                ) : null}
                {mix.canApprove && mix.draftRevision && mix.effectiveRevision ? (
                  <p className="field-hint">
                    After approval you choose which open records made from earlier revisions take
                    the new values.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="field-hint concrete-lead-only">
                Only the project’s Lead Project Engineer can edit or approve this mix.
              </p>
            )}
          </SidePanel>
          <SidePanel title="Supplier">
            <SupplierLink key={mix.version} mix={mix} onDone={managed} />
          </SidePanel>
          <SidePanel title="Mix design document">
            <p className="field-hint">
              Attaching the supplier’s mix design document arrives with file storage (C15).
            </p>
          </SidePanel>
        </aside>
      </div>

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
