import { formatReceiver, projectLabel } from '@materialmule/shared';
import type { ReactNode } from 'react';
import {
  formatSummaryValue,
  formatUnitCount,
  unitName,
  UNIT_TYPE_LABEL,
  type ReceiptDraft,
} from './draft';

/** Step 2: everything entered, read-only and grouped per unit, with Edit links (MM-T10). */
export function ReceiptReview({
  draft,
  onEditDetails,
  onEditUnit,
}: {
  draft: ReceiptDraft;
  onEditDetails?: () => void;
  onEditUnit?: (clientRowId: string) => void;
}) {
  return (
    <>
      <section className="card review-section" aria-labelledby="review-details">
        <div className="section-header">
          <h2 id="review-details">Details</h2>
          {onEditDetails ? (
            <button type="button" className="link-button" onClick={onEditDetails}>
              Edit details
            </button>
          ) : null}
        </div>
        <dl className="details">
          <dt>Project</dt>
          <dd>{draft.project ? projectLabel(draft.project) : '—'}</dd>
          <dt>Received date</dt>
          <dd>{draft.receivedDate}</dd>
          <dt>Received by</dt>
          <dd>{draft.receiver ? formatReceiver(draft.receiver) : '—'}</dd>
          <dt>Description</dt>
          <dd>{draft.description.trim() || 'None'}</dd>
          <dt>Quantity</dt>
          <dd>{formatUnitCount(draft.units.length)}</dd>
        </dl>
      </section>

      {draft.units.map((unit, index) => {
        const name = unitName(index, unit);
        const headingId = `review-${unit.clientRowId}`;
        return (
          <section
            key={unit.clientRowId}
            className="card review-section"
            aria-labelledby={headingId}
          >
            <div className="section-header">
              <h2 id={headingId}>{name}</h2>
              {onEditUnit ? (
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Edit ${name}`}
                  onClick={() => onEditUnit(unit.clientRowId)}
                >
                  Edit
                </button>
              ) : null}
            </div>
            <dl className="details">
              <dt>Type</dt>
              <dd>{UNIT_TYPE_LABEL[unit.unitType]}</dd>
              {unit.summaries.map((summary) => (
                <SummaryRow key={summary.testHole.id} name={summary.testHole.name}>
                  {formatSummaryValue(summary)}
                  {summary.note.trim() ? ` (note: ${summary.note.trim()})` : ''}
                </SummaryRow>
              ))}
              {unit.note.trim() ? (
                <>
                  <dt>Note</dt>
                  <dd>{unit.note.trim()}</dd>
                </>
              ) : null}
            </dl>
          </section>
        );
      })}
    </>
  );
}

function SummaryRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}
