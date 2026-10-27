import { formatReceiver, projectLabel } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { BandedCard } from '../components/ui';
import { useMediaQuery, WIDE_SCREEN } from '../components/useMediaQuery';
import {
  formatSummaryValue,
  formatUnitCount,
  unitName,
  UNIT_TYPE_LABEL,
  type ReceiptDraft,
} from './draft';

/**
 * Step 2: everything entered, read-only and grouped per unit, with Edit links (MM-T10). Above
 * 1280px (MM-T66) the Details card is one compact strip (UI-11, CSS) and the units are one table
 * with shared headers and a row per unit (UI-08); at 1280px and below each unit has its own card.
 */
export function ReceiptReview({
  draft,
  onEditDetails,
  onEditUnit,
}: {
  draft: ReceiptDraft;
  onEditDetails?: () => void;
  onEditUnit?: (clientRowId: string) => void;
}) {
  const wide = useMediaQuery(WIDE_SCREEN);
  const description = draft.description.trim() || 'None';
  const project = draft.project ? projectLabel(draft.project) : '—';
  const receiver = draft.receiver ? formatReceiver(draft.receiver) : '—';
  return (
    <>
      <BandedCard
        className="review-section review-details"
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
          <dd title={project}>{project}</dd>
          <dt>Received date</dt>
          <dd>{draft.receivedDate}</dd>
          <dt>Received by</dt>
          <dd title={receiver}>{receiver}</dd>
          <dt>Description</dt>
          <dd title={description}>{description}</dd>
          <dt>Quantity</dt>
          <dd>{formatUnitCount(draft.units.length)}</dd>
        </dl>
      </BandedCard>

      {wide ? (
        <UnitTable draft={draft} onEditUnit={onEditUnit} />
      ) : (
        <UnitCards draft={draft} onEditUnit={onEditUnit} />
      )}
    </>
  );
}

function summaryText(summary: ReceiptDraft['units'][number]['summaries'][number]): string {
  const note = summary.note.trim();
  return `${formatSummaryValue(summary)}${note ? ` (note: ${note})` : ''}`;
}

/** Above 1280px: every unit in one table, one compact row each, Edit at the end (UI-08). */
function UnitTable({
  draft,
  onEditUnit,
}: {
  draft: ReceiptDraft;
  onEditUnit?: (clientRowId: string) => void;
}) {
  return (
    <BandedCard className="review-section review-units" title="Storage units">
      <div className="review-units-scroll">
        <table className="data-table review-units-table">
          <caption className="visually-hidden">Storage units in this receipt</caption>
          <thead>
            <tr>
              <th scope="col">Storage unit</th>
              <th scope="col">Type</th>
              <th scope="col">Test holes (SAMPLE#/DEPTH)</th>
              <th scope="col">Note</th>
              {onEditUnit ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {draft.units.map((unit, index) => {
              const name = unitName(index, unit);
              return (
                <tr key={unit.clientRowId}>
                  <th scope="row">{name}</th>
                  <td>{UNIT_TYPE_LABEL[unit.unitType]}</td>
                  <td>
                    <ul className="review-summaries">
                      {unit.summaries.map((summary) => (
                        <li key={summary.testHole.id}>
                          <span className="review-hole">{summary.testHole.name}</span>{' '}
                          {summaryText(summary)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>{unit.note.trim() || '—'}</td>
                  {onEditUnit ? (
                    <td className="review-unit-action">
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`Edit ${name}`}
                        onClick={() => onEditUnit(unit.clientRowId)}
                      >
                        Edit
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </BandedCard>
  );
}

/** At 1280px and below: a card per unit. */
function UnitCards({
  draft,
  onEditUnit,
}: {
  draft: ReceiptDraft;
  onEditUnit?: (clientRowId: string) => void;
}) {
  return (
    <>
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
                  {summaryText(summary)}
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
