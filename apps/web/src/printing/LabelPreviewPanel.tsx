import type { LabelPreview } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState } from '../components/ui';
import { fetchLabelPreview, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import './labels.css';
import { receiptPrintPath, unitPrintPath } from './print-paths';

/**
 * Preview label (MM-T39): the unit's sticker exactly as T14 lays it out, at true size with a zoom
 * toggle, its fit warnings, and a link to the print view for Print / Save as PDF. Read-only: no
 * print job, no label print recorded.
 */
export function LabelPreviewPanel({
  storageUnit,
  receipt,
  openInNewTab = false,
}: {
  /** UUID or readable ID. */
  storageUnit: string;
  /** Offer the receipt-level print view when the receipt has more than one unit. */
  receipt?: { id: string; quantity: number };
  /** The receiving wizard opens print views in a new tab so its own state is kept. */
  openInNewTab?: boolean;
}) {
  const [result, setResult] = useState<{
    key: string;
    value: PreviewResult<LabelPreview>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const key = `${storageUnit}:${reloads}`;

  useEffect(() => {
    let cancelled = false;
    void fetchLabelPreview(storageUnit).then((value) => {
      if (!cancelled) setResult({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [storageUnit, key]);

  const newTab = openInNewTab ? { target: '_blank', rel: 'noopener' } : {};

  if (!result || result.key !== key) {
    return <p aria-busy="true">Loading label preview…</p>;
  }
  if (!result.value.ok) {
    return result.value.notFound ? (
      <EmptyState>No storage unit found, so there is no label to preview.</EmptyState>
    ) : (
      <ErrorState message={result.value.message} onRetry={() => setReloads((n) => n + 1)} />
    );
  }

  const preview = result.value.data;
  return (
    <div className="label-preview">
      <div className={`label-preview-frame${zoomed ? ' zoomed' : ''}`}>
        <LabelImage svg={preview.svg} readableId={preview.readableId} className="label-image" />
      </div>
      <p className="field-hint label-preview-size">
        <span className="label-preview-true-size">
          {zoomed ? 'Zoomed to twice the real size.' : 'Shown at the real size, 3.5 × 1.5 in.'}
        </span>
        <span className="label-preview-scaled">
          Scaled down to fit this screen, so not true size here. The PDF is true size.
        </span>
      </p>
      {preview.warnings.length > 0 ? (
        <ul className="label-warnings" aria-label="Fit warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <p className="field-hint">
        Printer fonts may differ slightly; the ZD621 print is the final check. Template{' '}
        {preview.templateVersion}.
      </p>
      <div className="issued-actions">
        <button type="button" aria-pressed={zoomed} onClick={() => setZoomed((z) => !z)}>
          Zoom in
        </button>
        <Link className="button" to={unitPrintPath(preview.readableId)} {...newTab}>
          Print / Save as PDF
        </Link>
        {receipt && receipt.quantity > 1 ? (
          <Link className="button" to={receiptPrintPath(receipt.id)} {...newTab}>
            Print / Save all {receipt.quantity} labels of this receipt
          </Link>
        ) : null}
      </div>
    </div>
  );
}
