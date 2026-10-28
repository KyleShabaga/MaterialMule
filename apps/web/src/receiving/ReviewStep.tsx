import { formatReceiver, projectLabel } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { BandedCard } from '../components/ui';
import { useMediaQuery, WIDE_SCREEN } from '../components/useMediaQuery';
import {
  bulkChoiceText,
  bulkSamplesInDraft,
  formatSampleDraft,
  formatSummaryValue,
  formatUnitCount,
  unitKindLabel,
  unitName,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';

/**
 * Step 2: everything entered, read-only and grouped per unit, with Edit links (MM-T10). Above
 * 1280px (MM-T66) the Details card is one compact strip (UI-11, CSS) and the units are one table
 * with shared headers and a row per unit (UI-08); at 1280px and below each unit has its own card.
 * Both show each unit's holder and contents (MM-T36): hole summaries, a Shelby tube's sampling
 * source, or a bulk soil bucket's bulk sample with its place among this receipt's buckets; the
 * receipt's bulk samples are then listed with their bucket counts.
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
      <BulkSamples draft={draft} wide={wide} />
    </>
  );
}

function summaryText(summary: ReceiptDraft['units'][number]['summaries'][number]): string {
  const note = summary.note.trim();
  return `${formatSummaryValue(summary)}${note ? ` (note: ${note})` : ''}`;
}

/** "bucket 1 of 2 in this receipt" for a bulk row, counted among this receipt's buckets. */
function bulkPosition(draft: ReceiptDraft, unit: UnitDraft): string {
  const group = bulkSamplesInDraft(draft).find((g) => g.rows.some((r) => r.unit === unit));
  if (!group) return '';
  const position = group.rows.findIndex((r) => r.unit === unit) + 1;
  return `bucket ${position} of ${group.rows.length} in this receipt`;
}

/** A unit's contents as review lines: hole summaries, a tube's source, or its bulk sample. */
function contentLines(draft: ReceiptDraft, unit: UnitDraft): { label: string; text: string }[] {
  if (unit.unitType === 'shelby_tube') {
    return [{ label: 'Sampling source', text: formatSampleDraft(unit.tube) }];
  }
  if (unit.bulk) {
    return [
      {
        label: 'Bulk sample',
        text: `${bulkChoiceText(draft, unit)} · ${bulkPosition(draft, unit)}`,
      },
    ];
  }
  return unit.summaries.map((summary) => ({
    label: summary.testHole.name,
    text: summaryText(summary),
  }));
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
              <th scope="col">Sampling source (SAMPLE#/DEPTH)</th>
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
                  <td>{unitKindLabel(unit)}</td>
                  <td>
                    <ul className="review-summaries">
                      {contentLines(draft, unit).map((line) => (
                        <li key={line.label}>
                          <span className="review-hole">{line.label}</span> {line.text}
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
              <dd>{unitKindLabel(unit)}</dd>
              {contentLines(draft, unit).map((line) => (
                <SummaryRow key={line.label} name={line.label}>
                  {line.text}
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

/**
 * This receipt's bulk samples, each with its physical buckets (a one-bucket sample is valid).
 * Storage unit IDs are issued only at confirmation, so buckets are named by row here; the Labels
 * step lists each BKT ID.
 */
function BulkSamples({ draft, wide }: { draft: ReceiptDraft; wide: boolean }) {
  const samples = bulkSamplesInDraft(draft);
  if (samples.length === 0) return null;
  const count = (n: number) => `${n} bucket${n === 1 ? '' : 's'}`;
  const joined = (existing: (typeof samples)[number]['existing']) =>
    existing ? `existing bulk sample, ${count(existing.memberCount)} already` : 'new bulk sample';
  return (
    <BandedCard className="review-section review-bulk" title="Bulk samples in this receipt">
      {wide ? (
        <table className="data-table review-units-table">
          <caption className="visually-hidden">Bulk samples in this receipt</caption>
          <thead>
            <tr>
              <th scope="col">Bulk sample</th>
              <th scope="col">Buckets in this receipt</th>
              <th scope="col">Storage units</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((sample) => (
              <tr key={sample.key}>
                <th scope="row">
                  {sample.text} <span className="field-hint">({joined(sample.existing)})</span>
                </th>
                <td>{count(sample.rows.length)}</td>
                <td>{sample.rows.map((r) => unitName(r.index, r.unit)).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <dl className="details">
          {samples.map((sample) => (
            <SummaryRow key={sample.key} name={sample.text}>
              {`${count(sample.rows.length)} (${joined(sample.existing)}): ${sample.rows
                .map((r) => unitName(r.index, r.unit))
                .join(', ')}`}
            </SummaryRow>
          ))}
        </dl>
      )}
    </BandedCard>
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
