import type { LabelPreview } from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BandedCard, EmptyState, ErrorState } from '../components/ui';
import { fetchLabelPreview, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import { LabelPrintSteps } from './LabelPrintPage';
import './labels.css';
import { receiptPrintPath, unitPrintPath } from './print-paths';

/**
 * Preview label (MM-T39): the unit's sticker exactly as T14 lays it out, at true size with a zoom
 * toggle, its fit warnings, and a link to the print view for Print / Save as PDF. Read-only: no
 * print job, no label print recorded.
 *
 * `layout="dual"` (MM-T55, approved 2026-10-26) is the storage unit page's Labels section: a
 * "Preview label" card beside a "Print view" card with the print steps and one page per label.
 * The print view opens in a new tab. On a phone the print view stacks below.
 */
export function LabelPreviewPanel({
  storageUnit,
  receipt,
  openInNewTab = false,
  layout = 'plain',
  id,
}: {
  /** UUID or readable ID. */
  storageUnit: string;
  /** Offer the receipt-level print view when the receipt has more than one unit. */
  receipt?: { id: string; quantity: number };
  /** The receiving wizard opens print views in a new tab so its own state is kept. */
  openInNewTab?: boolean;
  layout?: 'plain' | 'dual';
  /** Anchor id for the dual layout's Preview label card. */
  id?: string;
}) {
  const [result, setResult] = useState<{
    key: string;
    value: PreviewResult<LabelPreview>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const key = `${storageUnit}:${reloads}`;
  const dual = layout === 'dual';

  useEffect(() => {
    let cancelled = false;
    void fetchLabelPreview(storageUnit).then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [storageUnit, key]);

  const newTab = openInNewTab || dual ? { target: '_blank', rel: 'noopener' } : {};
  const preview = result?.key === key && result.value.ok ? result.value.data : null;

  let body: ReactNode;
  if (!result || result.key !== key) {
    body = <p aria-busy="true">Loading label preview…</p>;
  } else if (!result.value.ok) {
    body = result.value.notFound ? (
      <EmptyState>No storage unit found, so there is no label to preview.</EmptyState>
    ) : (
      <ErrorState message={result.value.message} onRetry={() => setReloads((n) => n + 1)} />
    );
  } else {
    const label = result.value.data;
    body = (
      <div className="label-preview">
        <div className={dual ? 'label-preview-well' : undefined}>
          <div className={`label-preview-frame${zoomed ? ' zoomed' : ''}`}>
            <LabelImage svg={label.svg} readableId={label.readableId} className="label-image" />
          </div>
          <p className="field-hint label-preview-size">
            <span className="label-preview-true-size">
              {zoomed ? 'Zoomed to twice the real size.' : 'Shown at the real size, 3.5 × 1.5 in.'}
            </span>
            <span className="label-preview-scaled">
              Scaled down to fit this screen, so not true size here. The PDF is true size.
            </span>
          </p>
        </div>
        {label.warnings.length > 0 ? (
          <div className={dual ? 'label-warnings-panel' : undefined}>
            {dual ? <h3>Fit warnings</h3> : null}
            <ul className="label-warnings" aria-label="Fit warnings">
              {label.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="field-hint">
          Printer fonts may differ slightly; the ZD621 print is the final check.
          {dual ? null : ` Template ${label.templateVersion}.`}
        </p>
        <div className="issued-actions">
          <button type="button" aria-pressed={zoomed} onClick={() => setZoomed((z) => !z)}>
            Zoom in
          </button>
          <Link
            className={dual ? 'button primary' : 'button'}
            to={unitPrintPath(label.readableId)}
            {...newTab}
          >
            Print / Save as PDF
            {dual ? <span aria-hidden="true"> ↗</span> : null}
          </Link>
          {receipt && receipt.quantity > 1 ? (
            <Link
              className="button"
              to={receiptPrintPath(receipt.id, label.readableId)}
              {...newTab}
            >
              Print / Save all {receipt.quantity} labels of this receipt
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  if (!dual) return body;

  return (
    <div className="labels-dual">
      <BandedCard
        as="div"
        id={id}
        title="Preview label"
        aside={
          preview ? (
            <span className="banded-card-meta">Template {preview.templateVersion}</span>
          ) : undefined
        }
      >
        {body}
      </BandedCard>
      <BandedCard
        as="div"
        title="Print view · 1 label"
        aside={<span className="banded-card-meta">Opens in a new tab</span>}
      >
        <LabelPrintSteps />
        <p className="field-hint">
          This doesn&apos;t count as a label print and creates no print job.
        </p>
        {preview ? (
          <div className="label-print-pages" aria-label="Pages in the print view">
            <span className="label-page-number">Page 1 of 1</span>
            <div className="label-page">
              <LabelImage
                svg={preview.svg}
                readableId={preview.readableId}
                alt={`Page 1: label for storage unit ${preview.readableId}`}
              />
            </div>
          </div>
        ) : null}
      </BandedCard>
    </div>
  );
}
