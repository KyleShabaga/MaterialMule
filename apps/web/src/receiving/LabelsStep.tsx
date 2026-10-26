import type { ConfirmReceiptResponse } from '@trapezoid/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { PrintLabelsPanel } from '../printing/PrintLabelsPanel';
import { receiptPrintPath } from '../printing/print-paths';
import { VerifyLabelsPanel } from '../scanning/VerifyLabelsPanel';
import { formatSummaryValue, unitName, type ReceiptDraft } from './draft';

/**
 * Step 3 (TRP-T10): the issued storage unit IDs (BKT- for buckets) with Print all, Print one
 * (TRP-T15 print queue), Preview label and Print / Save as PDF (TRP-T39) and Open storage unit.
 * Print views open in a new tab so this step stays on screen.
 */
export function LabelsStep({
  draft,
  result,
  onReceiveAnother,
}: {
  draft: ReceiptDraft;
  result: ConfirmReceiptResponse;
  onReceiveAnother: () => void;
}) {
  const rows = draft.units.map((unit, index) => ({
    unit,
    index,
    issued: result.units.find((u) => u.clientRowId === unit.clientRowId),
  }));
  const [verifying, setVerifying] = useState(false);

  return (
    <>
      <section className="card" aria-labelledby="labels-heading">
        <h2 id="labels-heading">Receipt confirmed</h2>
        <p role="status">
          {result.units.length === 1
            ? '1 storage unit received. Print its label and stick it on the bucket.'
            : `${result.units.length} storage units received. Print the labels and stick one on each bucket.`}
        </p>
        <PrintLabelsPanel
          storageUnitIds={result.units.map((u) => u.storageUnitId)}
          kind="initial"
          buttonLabel="Print all labels"
        />
        <p>
          <Link
            className="button"
            to={receiptPrintPath(result.receiptId)}
            target="_blank"
            rel="noopener"
          >
            Print / Save all labels as PDF
          </Link>
        </p>
      </section>

      <ul className="issued-units" aria-label="New storage units">
        {rows.map(({ unit, index, issued }) => (
          <li key={unit.clientRowId} className="card issued-unit">
            <h3>{issued?.suNumber ?? '—'}</h3>
            <p>
              {unitName(index, unit)}
              {unit.summaries.map((s) => ` · ${s.testHole.name}: ${formatSummaryValue(s)}`)}
            </p>
            {issued ? (
              <div className="issued-actions">
                <PrintLabelsPanel
                  storageUnitIds={[issued.storageUnitId]}
                  kind="initial"
                  buttonLabel={`Print ${issued.suNumber}`}
                />
                <Link
                  className="button"
                  to={`/sample-storage/${encodeURIComponent(issued.suNumber)}`}
                >
                  Open {issued.suNumber}
                </Link>
              </div>
            ) : null}
            {issued ? <UnitPreview storageUnitId={issued.storageUnitId} /> : null}
          </li>
        ))}
      </ul>

      {verifying ? (
        <VerifyLabelsPanel
          expectedIds={result.units.map((u) => u.suNumber)}
          onClose={() => setVerifying(false)}
        />
      ) : null}

      <div className="wizard-actions">
        {verifying ? null : (
          <button type="button" onClick={() => setVerifying(true)}>
            Verify labels
          </button>
        )}
        <button type="button" className="primary" onClick={onReceiveAnother}>
          Receive another
        </button>
      </div>
    </>
  );
}

/** Collapsed until opened, so a large receipt doesn't load every preview at once. */
function UnitPreview({ storageUnitId }: { storageUnitId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="label-preview-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Preview label</summary>
      {open ? <LabelPreviewPanel storageUnit={storageUnitId} openInNewTab /> : null}
    </details>
  );
}
