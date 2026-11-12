import type { LabelPreview } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState, ErrorState } from '../components/app-ui';
import { fetchLabelPreview, fetchReceiptLabelPreviews, type PreviewResult } from './api';
import { LabelImage } from './LabelImage';
import { MAX_CHOSEN_LABELS } from './print-paths';
import { PrintLabelsPanel } from './PrintLabelsPanel';
import './labels.css';

/**
 * Page size for Print → Save as PDF: one 3.5 × 1.5 in label per page, no margins. Rendered only
 * while the print view is open, so printing any other screen keeps the browser's paper size.
 * A fixed string: no user data is ever placed in it. Physical output: never restyle it.
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
type Scope = 'unit' | 'receipt' | 'units';

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

/** Readable IDs from `?ids=`, de-duplicated, at most MAX_CHOSEN_LABELS. */
function chosenIds(searchParams: URLSearchParams): string[] {
  const ids = (searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_CHOSEN_LABELS);
}

async function loadChosen(ids: string[]): Promise<Labels> {
  const results = await Promise.all(ids.map((id) => fetchLabelPreview(id)));
  const failed = results.find((r) => !r.ok && !r.notFound);
  if (failed && !failed.ok) return failed;
  return { ok: true, data: results.flatMap((r) => (r.ok ? [r.data] : [])) };
}

/**
 * Print view (MM-T39): one label, every label of a receipt in order, or units chosen on
 * Inventory, with no app chrome so the browser's Print → Save as PDF gives a true-scale PDF.
 * Saving a PDF never creates a print job and is not recorded as a label print.
 *
 * Field Ledger restyles the screen chrome only: the labels at about actual size, each with a
 * "Print this one" checkbox, and a Print panel that saves the chosen ones as a PDF or sends them
 * to the label printer (a print job, recorded on each unit). The printed label is unchanged.
 */
export function LabelPrintPage({ scope }: { scope: Scope }) {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const ids = scope === 'units' ? chosenIds(searchParams) : [];
  const idsKey = ids.join(',');
  const key = `${scope}:${id}:${idsKey}`;
  const [reloads, setReloads] = useState(0);
  const [result, setResult] = useState<{ key: string; value: Labels } | null>(null);
  const loadKey = `${key}:${reloads}`;
  /** Labels left out of this print, by storage unit ID. */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load: Promise<Labels> =
      scope === 'unit'
        ? fetchLabelPreview(id).then((r) => (r.ok ? { ok: true, data: [r.data] } : r))
        : scope === 'receipt'
          ? fetchReceiptLabelPreviews(id).then((r) =>
              r.ok ? { ok: true, data: r.data.labels } : r,
            )
          : loadChosen(idsKey === '' ? [] : idsKey.split(','));
    void load.then((value) => {
      if (!cancelled) setResult({ key: loadKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [scope, id, idsKey, loadKey]);

  const loaded = result?.key === loadKey && result.value.ok ? result.value.data : null;
  // MTR-48: disposed units are never printed; a receipt's print view names the ones it skips.
  const labels = loaded?.filter((label) => !label.disposed) ?? null;
  const disposed = loaded?.filter((label) => label.disposed) ?? [];
  const chosen = labels?.filter((label) => !skipped.has(label.storageUnitId)) ?? [];
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
    <Link to="/sample-storage">← Back to inventory</Link>
  );

  let body;
  if (!result || result.key !== loadKey) {
    body = <p aria-busy="true">Loading labels…</p>;
  } else if (!result.value.ok) {
    body = result.value.notFound ? (
      <EmptyState>
        {scope === 'unit'
          ? `No storage unit found with ID ${id}.`
          : scope === 'receipt'
            ? 'No receipt found.'
            : 'No storage units found.'}
      </EmptyState>
    ) : (
      <ErrorState message={result.value.message} onRetry={() => setReloads((n) => n + 1)} />
    );
  } else if (result.value.data.length === 0) {
    body = (
      <EmptyState>
        {scope === 'receipt'
          ? 'This receipt has no storage units to label.'
          : 'No storage units were chosen to label.'}
      </EmptyState>
    );
  } else if (scope === 'unit' && disposed.length > 0) {
    body = <p role="status">{DISPOSED_NOTE}</p>;
  } else if (disposed.length > 0) {
    body = (
      <p role="status">
        {labels!.length === 0
          ? `Every storage unit ${scope === 'receipt' ? 'on this receipt' : 'chosen'} is disposed, so no labels are printed. `
          : ''}
        Disposed units are not printed again: {disposed.map((label) => label.readableId).join(', ')}
        .
      </p>
    );
  }

  const heading =
    loaded && scope === 'unit'
      ? `Label ${loaded[0]!.readableId}`
      : labels && labels.length > 0
        ? labels.length === 1
          ? `Label ${labels[0]!.readableId}`
          : `${labels.length} labels`
        : 'Labels';

  return (
    <main className="label-print">
      <style>{PRINT_CSS}</style>
      <section
        className="label-print-instructions label-print-head"
        aria-labelledby="label-print-heading"
      >
        <div className="context-row">
          <span className="back-link">{back}</span>
        </div>
        <div className="label-print-title">
          <h1 id="label-print-heading">{heading}</h1>
          {labels && labels.length > 0 ? (
            <span className="label-print-meta">
              {labels.length} {labels.length === 1 ? 'unit label' : 'unit labels'} · shown at about
              actual size · 3.5 × 1.5 in
            </span>
          ) : null}
        </div>
        {body}
      </section>
      {labels && labels.length > 0 ? (
        <>
          {/* Exactly the pages that print: one .label-page per chosen label (physical output). */}
          <div className="label-sheet" aria-label="Labels to print">
            {chosen.map((label) => (
              <div className="label-page" key={label.storageUnitId}>
                <LabelImage svg={label.svg} readableId={label.readableId} />
              </div>
            ))}
          </div>
          <aside
            className="label-print-instructions label-print-panel"
            aria-labelledby="label-print-panel-heading"
          >
            <div className="side-panel-head">
              <h2 id="label-print-panel-heading">Print</h2>
            </div>
            <div className="side-panel-body">
              <p className="label-print-chosen">
                {chosen.length} of {labels.length} {labels.length === 1 ? 'label' : 'labels'} chosen
              </p>
              {labels.length > 1 ? (
                <fieldset className="label-print-choices">
                  <legend className="field-label">Choose labels</legend>
                  {labels.map((label) => {
                    const checkboxId = `print-${label.storageUnitId}`;
                    return (
                      <div className="label-print-choice" key={label.storageUnitId}>
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={!skipped.has(label.storageUnitId)}
                          onChange={(event) =>
                            setSkipped((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.delete(label.storageUnitId);
                              else next.add(label.storageUnitId);
                              return next;
                            })
                          }
                        />
                        <label htmlFor={checkboxId} className="mono">
                          {label.readableId}
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
              ) : null}
              <h3>Label printer</h3>
              <PrintLabelsPanel
                key={chosen.map((label) => label.storageUnitId).join(',')}
                storageUnitIds={chosen.map((label) => label.storageUnitId)}
                kind="reprint"
                buttonLabel={
                  chosen.length === 1
                    ? 'Send 1 label to the printer'
                    : `Send ${chosen.length} labels to the printer`
                }
              />
              <p className="field-hint">
                A print is recorded on each unit’s history with who printed it. The ID on a label
                never changes.
              </p>
              <h3>PDF</h3>
              <LabelPrintSteps />
              <p className="field-hint">
                This doesn&apos;t count as a label print and creates no print job. Printer fonts may
                differ slightly; the ZD621 print is the final check.
              </p>
              <button type="button" disabled={chosen.length === 0} onClick={() => window.print()}>
                Print / Save as PDF
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </main>
  );
}
