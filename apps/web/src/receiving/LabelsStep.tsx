import type { ConfirmReceiptResponse } from '@materialmule/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { BandedCard } from '../components/ui';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { PrintLabelsPanel } from '../printing/PrintLabelsPanel';
import { receiptPrintPath } from '../printing/print-paths';
import { VerifyLabelsPanel } from '../scanning/VerifyLabelsPanel';
import { unitHeadline, type ReceiptDraft } from './draft';

/**
 * Step 3 (MM-T10): the issued storage unit IDs (BKT- for buckets, ST- for Shelby tubes) with Print all, Print one
 * (MM-T15 print queue), Preview label and Print / Save as PDF (MM-T39) and Open storage unit.
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
      <BandedCard title="Receipt confirmed">
        <p role="status">
          {result.units.length === 1
            ? '1 storage unit received. Print its label and stick it on the bucket or tube.'
            : `${result.units.length} storage units received. Print the labels and stick one on each bucket or tube.`}
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
      </BandedCard>

      <ul className="issued-units" aria-label="New storage units">
        {rows.map(({ unit, index, issued }) => (
          <li key={unit.clientRowId} className="card issued-unit">
            <h3>{issued?.suNumber ?? '—'}</h3>
            {/* App metadata only: the sticker itself never shows sample references, depths or
                bulk samples (MM-T36 sticker contract). */}
            <p>{unitHeadline(index, unit, draft)}</p>
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
