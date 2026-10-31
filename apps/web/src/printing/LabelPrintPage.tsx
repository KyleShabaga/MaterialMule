import type { LabelPreview } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState, ErrorState } from '../components/ui';
import { fetchLabelPreview, fetchReceiptLabelPreviews, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import './labels.css';

/**
 * Page size for Print → Save as PDF: one 3.5 × 1.5 in label per page, no margins. Rendered only
 * while the print view is open, so printing any other screen keeps the browser's paper size.
 * A fixed string: no user data is ever placed in it.
 */
const PRINT_CSS = `
@page { size: 3.5in 1.5in; margin: 0; }
@media print {
  :root, html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  .label-print { margin: 0; padding: 0; max-width: none; }
  .label-print-instructions { display: none !important; }
  .label-sheet { display: block; margin: 0; padding: 0; }
  .label-page { width: 3.5in; height: 1.5in; margin: 0; padding: 0; border: 0; box-shadow: none;
    overflow: hidden; break-inside: avoid; break-after: page; }
  .label-page:last-child { break-after: auto; }
  .label-page img { display: block; width: 3.5in; height: 1.5in; }
}
`;

type Labels = PreviewResult<LabelPreview[]>;

/** MTR-48 (MM-T77): a disposed unit's ID never gets a fresh sticker. */
export const DISPOSED_NOTE = 'This storage unit is disposed; its label is not printed again.';

/** The browser print settings for a true-size PDF; shared with the unit page's print view card. */
export function LabelPrintSteps() {
  return (
    <ol className="label-print-steps">
      <li>Choose Print / Save as PDF below.</li>
      <li>
        Set the scale to <strong>100% (Actual size)</strong>, not Fit to page. Margins: None.
      </li>
      <li>
        Each page is one 3.5 × 1.5 in label. Save as PDF, or print on 3.5 × 1.5 in label stock.
      </li>
    </ol>
  );
}

/**
 * Print view (MM-T39): one label, or every label of a receipt in order, with no app chrome so
 * the browser's Print → Save as PDF gives a true-scale PDF. Saving a PDF never creates a print job
 * and is not recorded as a label print.
 */
export function LabelPrintPage({ scope }: { scope: 'unit' | 'receipt' }) {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const key = `${scope}:${id}`;
  const [reloads, setReloads] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Labels } | null>(null);
  const loadKey = `${key}:${reloads}`;

  useEffect(() => {
    let cancelled = false;
    const load: Promise<Labels> =
      scope === 'unit'
        ? fetchLabelPreview(id).then((r) => (r.ok ? { ok: true, data: [r.data] } : r))
        : fetchReceiptLabelPreviews(id).then((r) => (r.ok ? { ok: true, data: r.data.labels } : r));
    void load.then((value) => {
      if (!cancelled) setResult({ key: loadKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [scope, id, loadKey]);

  const loaded = result?.key === loadKey && result.value.ok ? result.value.data : null;
  // MTR-48: disposed units are never printed; a receipt's print view names the ones it skips.
  const labels = loaded?.filter((label) => !label.disposed) ?? null;
  const skipped = loaded?.filter((label) => label.disposed) ?? [];
  // The unit to return to: the one shown, or for a receipt the unit it was opened from, if that
  // unit is on the receipt (MM-T61).
  const from = searchParams.get('from');
  const backUnit =
    scope === 'unit' ? loaded?.[0] : loaded?.find((label) => label.readableId === from);
  const back = backUnit ? (
    <Link to={`/sample-storage/${encodeURIComponent(backUnit.readableId)}`}>
      ← Back to {backUnit.readableId}
    </Link>
  ) : (
    <Link to="/sample-storage">← Back to Sample Storage</Link>
  );

  let body;
  if (!result || result.key !== loadKey) {
    body = <p aria-busy="true">Loading labels…</p>;
  } else if (!result.value.ok) {
    body = result.value.notFound ? (
      <EmptyState>
        {scope === 'unit' ? `No storage unit found with ID ${id}.` : 'No receipt found.'}
      </EmptyState>
    ) : (
      <ErrorState message={result.value.message} onRetry={() => setReloads((n) => n + 1)} />
    );
  } else if (result.value.data.length === 0) {
    body = <EmptyState>This receipt has no storage units to label.</EmptyState>;
  } else if (scope === 'unit' && skipped.length > 0) {
    body = <p role="status">{DISPOSED_NOTE}</p>;
  } else if (skipped.length > 0) {
    body = (
      <p role="status">
        {labels!.length === 0
          ? 'Every storage unit on this receipt is disposed, so no labels are printed. '
          : ''}
        Disposed units are not printed again: {skipped.map((label) => label.readableId).join(', ')}.
      </p>
    );
  }

  return (
    <main className="label-print">
      <style>{PRINT_CSS}</style>
      <section className="label-print-instructions" aria-labelledby="label-print-heading">
        <p className="back-link">{back}</p>
        <h1 id="label-print-heading">
          {loaded && scope === 'unit'
            ? `Label ${loaded[0]!.readableId}`
            : labels && labels.length > 0
              ? labels.length === 1
                ? `Label ${labels[0]!.readableId}`
                : `${labels.length} labels`
              : 'Labels'}
        </h1>
        {body}
        {labels && labels.length > 0 ? (
          <>
            <LabelPrintSteps />
            <p className="field-hint">
              This doesn&apos;t count as a label print and creates no print job. Printer fonts may
              differ slightly; the ZD621 print is the final check.
            </p>
            <button type="button" className="primary" onClick={() => window.print()}>
              Print / Save as PDF
            </button>
          </>
        ) : null}
      </section>
      {labels && labels.length > 0 ? (
        <div className="label-sheet" aria-label="Labels to print">
          {labels.map((label) => (
            <div className="label-page" key={label.storageUnitId}>
              <LabelImage svg={label.svg} readableId={label.readableId} />
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}
