import {
  CONCRETE_MIX_PROPAGATION_FIELD_LABEL,
  CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL,
  type ConcreteMixPropagationChange,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  BandedCard,
  ConfirmDialog,
  ErrorState,
  StatusBadge,
  TableScroll,
} from '../../components/ui';
import { ConcreteApiError, applyPropagation, concreteProblem, fetchPropagation } from './api';
import { mixPath } from './paths';
import { propagationValue } from './mix-format';
import { ConcreteFrame } from './ProjectConcretePage';
import { useLoad } from './useLoad';

// MM-V2-C30: the Lead's mix propagation review. After a revision is approved, existing reports and
// untested specimen schedules made from an earlier revision are listed with what would change.
// Nothing changes until the Lead approves items one by one or Approve all; ineligible records
// (non-drafts, tested or HOLD specimens, values changed by hand) are shown with the reason and
// never applied. Each decision is recorded in the mix's history with its scope.

const fieldLabel = (field: string) => CONCRETE_MIX_PROPAGATION_FIELD_LABEL[field] ?? field;

function ChangeList({ changes }: { changes: ConcreteMixPropagationChange[] }) {
  return (
    <ul className="propagation-changes">
      {changes.map((change) => (
        <li key={change.field}>
          {fieldLabel(change.field)}: {propagationValue(change.field, change.before)} →{' '}
          <strong>{propagationValue(change.field, change.proposed)}</strong>
        </li>
      ))}
    </ul>
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
      {() => <PropagationReview mixId={mixId} />}
    </ConcreteFrame>
  );
}

function PropagationReview({ mixId }: { mixId: string }) {
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
  const eligible = preview.items.filter((i) => i.eligible);
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

  const reports = preview.items.filter((i) => i.recordType === 'field_report');
  const specimens = preview.items.filter((i) => i.recordType === 'specimen');

  return (
    <>
      <h2>
        Records made from earlier revisions of {preview.supplierName} {preview.mixNumber}
      </h2>
      {preview.toRevisionNumber === null ? (
        <p>This mix has no approved revision yet, so there is nothing to update.</p>
      ) : (
        <p className="field-hint">
          Revision {preview.toRevisionNumber} is in effect. Choose which records take its values.
          Measured results, the supplier-ticket column, IDs and completed tests never change.
        </p>
      )}
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

      {reports.length > 0 ? (
        <ItemTable
          title="Field reports"
          items={reports}
          preview={preview}
          selected={selected}
          onToggle={(itemId, on) => {
            const next = new Set(selected);
            if (on) next.add(itemId);
            else next.delete(itemId);
            setSelected(next);
          }}
        />
      ) : null}
      {specimens.length > 0 ? (
        <ItemTable
          title="Untested specimen schedules"
          items={specimens}
          preview={preview}
          selected={selected}
          onToggle={(itemId, on) => {
            const next = new Set(selected);
            if (on) next.add(itemId);
            else next.delete(itemId);
            setSelected(next);
          }}
        />
      ) : null}

      {preview.canApply && eligible.length > 0 ? (
        <BandedCard title="Decision">
          <div className="concrete-form">
            <label htmlFor={`${id}-note`}>Note (optional, kept in the history)</label>
            <input
              id={`${id}-note`}
              type="text"
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="page-actions">
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
            </div>
          </div>
        </BandedCard>
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

function ItemTable({
  title,
  items,
  preview,
  selected,
  onToggle,
}: {
  title: string;
  items: ConcreteMixPropagationItem[];
  preview: ConcreteMixPropagationPreview;
  selected: Set<string>;
  onToggle: (itemId: string, on: boolean) => void;
}) {
  return (
    <BandedCard title={title} subtitle={`${items.length} listed`}>
      <TableScroll label={`${title} table`}>
        <table className="data-table propagation-table">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              {preview.canApply ? <th scope="col">Update</th> : null}
              <th scope="col">Record</th>
              <th scope="col">From revision</th>
              <th scope="col">Proposed change</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                {preview.canApply ? (
                  <td data-label="Update">
                    {item.eligible ? (
                      <input
                        type="checkbox"
                        aria-label={`Update ${item.recordLabel}`}
                        checked={selected.has(item.itemId)}
                        onChange={(e) => onToggle(item.itemId, e.target.checked)}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td data-label="Record">
                  <Link to={`/concrete/review/${encodeURIComponent(item.fieldReportId)}`}>
                    {item.recordLabel}
                  </Link>
                </td>
                <td data-label="From revision">{item.fromRevisionNumber ?? '—'}</td>
                <td data-label="Proposed change">
                  <ChangeList changes={item.changes} />
                  {item.kept.length > 0 ? (
                    <div className="propagation-kept">
                      <p className="field-hint">Changed by hand, kept as written:</p>
                      <ChangeList changes={item.kept} />
                    </div>
                  ) : null}
                </td>
                <td data-label="Status">
                  {item.eligible ? (
                    <StatusBadge tone="info">Can update</StatusBadge>
                  ) : (
                    <>
                      <StatusBadge tone="neutral">Won’t change</StatusBadge>
                      <p className="field-hint">
                        {item.ineligibleReason
                          ? CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL[item.ineligibleReason]
                          : null}
                      </p>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </BandedCard>
  );
}
