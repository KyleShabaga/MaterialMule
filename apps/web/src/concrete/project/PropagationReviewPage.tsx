import {
  CONCRETE_MIX_PROPAGATION_FIELD_LABEL,
  CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL,
  type ConcreteMixPropagationChange,
  type ConcreteMixPropagationIneligible,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import {
  ConfirmDialog,
  ErrorState,
  PageHeader,
  SectionHead,
  SidePanel,
  StatusBadge,
  TableScroll,
} from '../../components/app-ui';
import { ConcreteApiError, applyPropagation, concreteProblem, fetchPropagation } from './api';
import { mixPath, propagationPath } from './paths';
import { propagationValue } from './mix-format';
import { ConcreteFrame } from './ProjectConcretePage';
import { useLoad } from './useLoad';

// MM-V2-C30: the Lead's mix propagation review. After a revision is approved, existing reports and
// untested specimen schedules made from an earlier revision are listed with what would change.
// Nothing changes until the Lead approves items one by one or Approve all; ineligible records
// (non-drafts, tested or HOLD specimens, values changed by hand) are shown with the reason and
// never applied. Each decision is recorded in the mix's history with its scope.
// Field Ledger (canvas "ConcreteMixPropagation", "Update open records"): the records that can
// change, each old value struck through beside the new one, then the records left as they are
// with the reason; the decision sits at the side.

const fieldLabel = (field: string) => CONCRETE_MIX_PROPAGATION_FIELD_LABEL[field] ?? field;

const KIND_LABEL: Record<ConcreteMixPropagationItem['recordType'], string> = {
  field_report: 'Field report',
  specimen: 'Untested specimen schedule',
};

/** The short tag beside a record that will be left alone; the reason is written beside it. */
const LEFT_TAG: Record<ConcreteMixPropagationIneligible, string> = {
  report_ready_to_submit: 'Not a draft',
  report_submitted: 'Not a draft',
  report_returned: 'Not a draft',
  report_reviewed: 'Not a draft',
  report_issued: 'Not a draft',
  manually_edited: 'Kept',
  specimen_tested: 'Tested',
  hold_specimen: 'HOLD',
  no_casting_time: 'No casting time',
};

function ChangeList({ changes }: { changes: ConcreteMixPropagationChange[] }) {
  return (
    <ul className="propagation-changes">
      {changes.map((change) => (
        <li key={change.field}>
          <span className="propagation-field">{fieldLabel(change.field)}</span>{' '}
          <span className="propagation-values mono">
            <span className="visually-hidden">from </span>
            <s>{propagationValue(change.field, change.before)}</s>{' '}
            <span className="visually-hidden">to </span>
            <strong>{propagationValue(change.field, change.proposed)}</strong>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecordCell({ item }: { item: ConcreteMixPropagationItem }) {
  return (
    <>
      <Link
        className="mono propagation-record"
        to={`/concrete/review/${encodeURIComponent(item.fieldReportId)}`}
      >
        {item.recordLabel}
      </Link>
      <span className="propagation-kind">
        {KIND_LABEL[item.recordType]} · from revision {item.fromRevisionNumber ?? '—'}
      </span>
    </>
  );
}

export function PropagationReviewPage() {
  const { projectId = '', mixId = '' } = useParams();
  return (
    <ConcreteFrame
      projectId={projectId}
      title="Mix propagation review"
      back={<Link to={mixPath(projectId, mixId)}>← Back to the mix</Link>}
    >
      {() => <PropagationReview projectId={projectId} mixId={mixId} />}
    </ConcreteFrame>
  );
}

function PropagationReview({ projectId, mixId }: { projectId: string; mixId: string }) {
  const id = useId();
  const { load, reload, replace } = useLoad(`propagation|${mixId}`, () => fetchPropagation(mixId));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  if (load.state === 'loading') return <p role="status">Loading…</p>;
  if (load.state === 'error') {
    return <ErrorState message={concreteProblem(load.error)} onRetry={reload} />;
  }
  const preview = load.data;
  // As the mix page: under another project's address, go to the mix's own project.
  if (preview.projectId !== projectId) {
    return <Navigate replace to={propagationPath(preview.projectId, preview.mixId)} />;
  }
  const eligible = preview.items.filter((i) => i.eligible);
  const left = preview.items.filter((i) => !i.eligible);
  const chosen = eligible.filter((i) => selected.has(i.itemId));

  function decide(selection: 'items' | 'approve_all') {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConfirmAll(false);
    applyPropagation(mixId, {
      idempotencyKey: crypto.randomUUID(),
      previewId: preview.previewId,
      selection:
        selection === 'items'
          ? { kind: 'items', itemIds: chosen.map((i) => i.itemId) }
          : { kind: 'approve_all', displayedItemIds: preview.items.map((i) => i.itemId) },
      note: note.trim() || null,
    })
      .then((result) => {
        replace(result.preview);
        setSelected(new Set());
        setNote('');
        const n = result.appliedItemIds.length;
        setNotice(
          `Updated ${n} ${n === 1 ? 'record' : 'records'} from the mix. The mix history records this decision.`,
        );
      })
      .catch((caught: unknown) => {
        if (caught instanceof ConcreteApiError && caught.code === 'preview_stale') {
          const current = (caught.body as { current?: ConcreteMixPropagationPreview } | null)
            ?.current;
          if (current) replace(current);
          setSelected(new Set());
        }
        setError(concreteProblem(caught));
      })
      .finally(() => setBusy(false));
  }

  function toggle(itemId: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(itemId);
    else next.delete(itemId);
    setSelected(next);
  }

  const canDecide = preview.canApply && eligible.length > 0;

  return (
    <>
      <div className="propagation-heading">
        <PageHeader title="Update open records" documentTitle={false} />
        <p className="concrete-record-meta">
          {preview.supplierName} {preview.mixNumber}
          {preview.toRevisionNumber !== null
            ? ` · revision ${preview.toRevisionNumber} in effect`
            : ''}
        </p>
      </div>
      <div className="propagation-call">
        <span className="field-label">Your call</span>
        <div>
          <p>
            Records made from earlier revisions of {preview.supplierName} {preview.mixNumber}.
          </p>
          {preview.toRevisionNumber === null ? (
            <p>This mix has no approved revision yet, so there is nothing to update.</p>
          ) : (
            <p>
              Revision {preview.toRevisionNumber} is in effect. Nothing changes unless you choose it
              here. Measured results, the supplier-ticket column, IDs and completed tests never
              change.
            </p>
          )}
        </div>
      </div>
      <p className="notice notice-success" role="status">
        {notice}
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {preview.items.length === 0 && preview.toRevisionNumber !== null ? (
        <p>Every report and schedule already uses revision {preview.toRevisionNumber}.</p>
      ) : null}
      {preview.truncated ? (
        <p className="field-hint">
          More records are affected than listed. Decide on these, then review again.
        </p>
      ) : null}
      {!preview.canApply && preview.items.length > 0 ? (
        <p className="field-hint concrete-lead-only">
          Only the project’s Lead Project Engineer can update records from the mix.
        </p>
      ) : null}

      {preview.items.length > 0 ? (
        <div className="concrete-split">
          <div className="concrete-split-main">
            {eligible.length > 0 ? (
              <section aria-labelledby={`${id}-can`}>
                <SectionHead
                  id={`${id}-can`}
                  title="Can be updated"
                  meta={
                    preview.canApply
                      ? `${chosen.length} of ${eligible.length} chosen`
                      : `${eligible.length} ${eligible.length === 1 ? 'record' : 'records'}`
                  }
                />
                <TableScroll label="Records that can be updated">
                  <table className="data-table propagation-table">
                    <caption className="visually-hidden">Records that can be updated</caption>
                    <thead>
                      <tr>
                        {preview.canApply ? <th scope="col">Update</th> : null}
                        <th scope="col">Record</th>
                        <th scope="col">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eligible.map((item) => {
                        const on = selected.has(item.itemId);
                        return (
                          <tr key={item.itemId} className={on ? 'is-selected' : undefined}>
                            {preview.canApply ? (
                              <td data-label="Update">
                                <input
                                  type="checkbox"
                                  aria-label={`Update ${item.recordLabel}`}
                                  checked={on}
                                  onChange={(e) => toggle(item.itemId, e.target.checked)}
                                />
                              </td>
                            ) : null}
                            <td data-label="Record">
                              <RecordCell item={item} />
                            </td>
                            <td data-label="Change">
                              <ChangeList changes={item.changes} />
                              {item.kept.length > 0 ? (
                                <div className="propagation-kept">
                                  <p className="field-hint">Changed by hand, kept as written:</p>
                                  <ChangeList changes={item.kept} />
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableScroll>
              </section>
            ) : null}

            {left.length > 0 ? (
              <section aria-labelledby={`${id}-left`}>
                <SectionHead
                  id={`${id}-left`}
                  title="Left as they are"
                  meta={`${left.length} ${left.length === 1 ? 'record' : 'records'}`}
                />
                <TableScroll label="Records left as they are">
                  <table className="data-table propagation-table">
                    <caption className="visually-hidden">Records left as they are</caption>
                    <thead>
                      <tr>
                        <th scope="col">Record</th>
                        <th scope="col">Why it stays</th>
                      </tr>
                    </thead>
                    <tbody>
                      {left.map((item) => (
                        <tr key={item.itemId}>
                          <td data-label="Record">
                            <RecordCell item={item} />
                          </td>
                          <td data-label="Why it stays">
                            <span className="propagation-reason">
                              {item.ineligibleReason ? (
                                <>
                                  <StatusBadge tone="closed">
                                    {LEFT_TAG[item.ineligibleReason]}
                                  </StatusBadge>{' '}
                                  {CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL[item.ineligibleReason]}
                                </>
                              ) : (
                                <StatusBadge tone="closed">Won’t change</StatusBadge>
                              )}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </section>
            ) : null}
          </div>

          {canDecide ? (
            <aside className="concrete-split-aside" aria-label="Decision">
              <SidePanel title="Apply">
                <div className="concrete-panel-stack">
                  <p>
                    {chosen.length} of {eligible.length}{' '}
                    {eligible.length === 1 ? 'record' : 'records'} chosen to take revision{' '}
                    {preview.toRevisionNumber}’s values. The mix history records this decision.
                  </p>
                  <div className="concrete-field">
                    <label htmlFor={`${id}-note`}>Note (optional, kept in the history)</label>
                    <input
                      id={`${id}-note`}
                      type="text"
                      maxLength={2000}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                  <div className="concrete-panel-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || chosen.length === 0}
                      onClick={() => decide('items')}
                    >
                      Approve selected ({chosen.length})
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
                      Approve all ({eligible.length})
                    </button>
                    <Link className="propagation-none" to={mixPath(projectId, mixId)}>
                      Change nothing
                    </Link>
                  </div>
                  <p className="field-hint">
                    If a record changes while this page is open, you are asked to look at the list
                    again before anything is applied.
                  </p>
                </div>
              </SidePanel>
            </aside>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmAll}
        title="Approve all listed records?"
        confirmLabel={`Update ${eligible.length}`}
        onConfirm={() => decide('approve_all')}
        onCancel={() => setConfirmAll(false)}
      >
        <p>
          All {eligible.length} eligible records listed here take revision{' '}
          {preview.toRevisionNumber}’s values. Records that can’t change stay as they are.
        </p>
      </ConfirmDialog>
    </>
  );
}
