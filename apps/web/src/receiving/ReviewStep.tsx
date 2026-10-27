import { formatReceiver, projectLabel } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { BandedCard } from '../components/ui';
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
      <BandedCard
        className="review-section"
        title="Details"
        aside={
          onEditDetails ? (
            <button type="button" className="link-button" onClick={onEditDetails}>
              Edit details
            </button>
          ) : undefined
        }
      >
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
      </BandedCard>

      {draft.units.map((unit, index) => {
        const name = unitName(index, unit);
        return (
          <BandedCard
            key={unit.clientRowId}
            className="review-section"
            title={name}
            aside={
              onEditUnit ? (
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Edit ${name}`}
                  onClick={() => onEditUnit(unit.clientRowId)}
                >
                  Edit
                </button>
              ) : undefined
            }
          >
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
          </BandedCard>
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
