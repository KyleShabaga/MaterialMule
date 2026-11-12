import { isPrintJobActive, type ConfirmReceiptResponse, type PrintJob } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Notice, SidePanel, UnitLabel } from '../components/app-ui';
import { confirmPhysicalPrint, requestPrint } from '../printing/api';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { PrintJobStatus } from '../printing/PrintJobStatus';
import { PrintLabelsPanel } from '../printing/PrintLabelsPanel';
import { receiptPrintPath } from '../printing/print-paths';
import { usePrintJob } from '../printing/usePrintJob';
import type { MoveLinkState } from '../moves/move-link';
import { VerifyLabelsPanel } from '../scanning/VerifyLabelsPanel';
import { UNIT_TYPE_LABEL, unitContentLines, type ReceiptDraft } from './draft';

/**
 * Receipt confirmed (Field Ledger "ReceiptDone", step 3 Confirm and label): one unit label per
 * issued ID, and a done / now / then panel whose primary action is the next physical task, putting
 * the units away. Labels print on confirm when "Print labels" was ticked; otherwise from here.
 * Print views open in a new tab so this screen stays up.
 */
export function ReceiptDone({
  draft,
  result,
  autoPrint,
  onReceiveAnother,
}: {
  draft: ReceiptDraft;
  result: ConfirmReceiptResponse;
  /** Send every label to the printer once, as soon as this screen opens. */
  autoPrint: boolean;
  onReceiveAnother: () => void;
}) {
  const rows = draft.units.map((unit) => ({
    unit,
    issued: result.units.find((u) => u.clientRowId === unit.clientRowId),
  }));
  const ids = result.units.map((u) => u.storageUnitId);
  const count = result.units.length;
  const [verifying, setVerifying] = useState(false);
  const [job, setJob] = useState<PrintJob | null>(null);
  const project = draft.project?.projectNumber ?? '';
  const labels = count === 1 ? '1 label' : `${count} labels`;
  const printed = job?.status === 'sent';

  return (
    <div className="receive-columns">
      <div className="receive-main">
        <p role="status" className="receive-done-status">
          {count === 1
            ? '1 storage unit received. Stick its label on the bucket, tube or box.'
            : `${count} storage units received. Stick one label on each bucket, tube or box.`}
        </p>
        <ul className="receive-done-units" aria-label="New storage units">
          {rows.map(({ unit, issued }) => (
            <li key={unit.clientRowId} className="receive-done-unit">
              <UnitLabel
                holder={(unit.bulk ? 'Bucket' : UNIT_TYPE_LABEL[unit.unitType]).toUpperCase()}
                project={project}
                unitId={issued?.suNumber ?? '—'}
                headingLevel={3}
                // App metadata only: the sticker itself never shows sample references, depths
                // or bulk samples (MM-T36 sticker contract).
                lines={unitContentLines(draft, unit).map((line) => ({
                  hole: line.hole,
                  summary: line.text,
                }))}
              />
              {unit.targetLocation?.trim() ? (
                <p className="receive-unit-target">Goes to {unit.targetLocation.trim()}</p>
              ) : null}
              {issued ? (
                <div className="issued-actions">
                  <Link
                    className="button"
                    to={`/sample-storage/${encodeURIComponent(issued.suNumber)}`}
                  >
                    Open {issued.suNumber}
                  </Link>
                  <PrintLabelsPanel
                    storageUnitIds={[issued.storageUnitId]}
                    kind="initial"
                    buttonLabel={`Print ${issued.suNumber}`}
                  />
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
      </div>

      <SidePanel title="Next: put them away" className="receive-side">
        <ol className="receive-checklist">
          <li>
            <span className="receive-check-state receive-check-done">DONE</span>
            <span>
              <strong>{count === 1 ? '1 ID issued' : `${count} IDs issued`}</strong>
              <span className="field-hint">
                {printed
                  ? `${labels} printed.`
                  : autoPrint
                    ? `${labels} sent to the label printer.`
                    : 'Print the labels below.'}
              </span>
            </span>
          </li>
          <li>
            <span className="receive-check-state">NOW</span>
            <span>
              <strong>Stick each label on its unit</strong>
              <span className="field-hint">Match the test hole written on the holder.</span>
            </span>
          </li>
          <li>
            <span className="receive-check-state receive-check-later">THEN</span>
            <span>
              <strong>Scan the units, then the shelf</strong>
              <span className="field-hint">Until then they show at Receiving.</span>
            </span>
          </li>
        </ol>
        <div className="receive-side-actions">
          <Link
            className="button primary receive-big"
            to="/sample-storage/move"
            // The units just received wait on Move units for their shelf (lane C's batch).
            state={{ units: result.units.map((u) => u.suNumber) } satisfies MoveLinkState}
          >
            {count === 1 ? 'Put this unit away' : `Put these ${count} away`}
          </Link>
          {autoPrint ? (
            <AutoPrint receiptId={result.receiptId} storageUnitIds={ids} onJob={setJob} />
          ) : (
            <PrintLabelsPanel
              storageUnitIds={ids}
              kind="initial"
              buttonLabel="Print all labels"
              onJobChange={setJob}
            />
          )}
          <Link
            className="button"
            to={receiptPrintPath(result.receiptId)}
            target="_blank"
            rel="noopener"
          >
            Print / Save all labels as PDF
          </Link>
          {verifying ? null : (
            <button type="button" onClick={() => setVerifying(true)}>
              Verify labels
            </button>
          )}
          <button type="button" onClick={onReceiveAnother}>
            Receive another
          </button>
          <Link to="/receiving-log" className="receive-side-link">
            Back to the receiving log
          </Link>
        </div>
      </SidePanel>
    </div>
  );
}

/** One request per receipt, even if this screen mounts twice (StrictMode, a quick remount). */
const autoPrints = new Map<string, ReturnType<typeof requestPrint>>();

/**
 * Sends every label once when the screen opens, then shows the job like PrintLabelsPanel does,
 * with Reprint all labels. A refused or failed print leaves the IDs issued: it says so.
 */
function AutoPrint({
  receiptId,
  storageUnitIds,
  onJob,
}: {
  receiptId: string;
  storageUnitIds: string[];
  onJob: (job: PrintJob) => void;
}) {
  const [job, setJob] = usePrintJob();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    let request = autoPrints.get(receiptId);
    if (!request) {
      request = requestPrint({ storageUnitIds, kind: 'initial' });
      autoPrints.set(receiptId, request);
    }
    void request.then((outcome) => {
      if (!current) return;
      if (outcome.ok) setJob(outcome.data);
      else setError(outcome.message);
    });
    return () => {
      current = false;
    };
    // One automatic print per receipt; the IDs never change for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  useEffect(() => {
    if (job) onJob(job);
  }, [job, onJob]);

  async function reprint() {
    setBusy(true);
    setError(null);
    const outcome = await requestPrint({ storageUnitIds, kind: job ? 'reprint' : 'initial' });
    setBusy(false);
    if (outcome.ok) setJob(outcome.data);
    else setError(outcome.message);
  }

  async function confirm() {
    if (!job) return;
    setBusy(true);
    const outcome = await confirmPhysicalPrint(job.id);
    setBusy(false);
    if (outcome.ok) setJob(outcome.data);
    else setError(outcome.message);
  }

  return (
    <div className="print-panel">
      {job ? <PrintJobStatus job={job} busy={busy} onConfirm={() => void confirm()} /> : null}
      {!job && !error ? <p aria-busy="true">Sending the labels to the printer…</p> : null}
      {error ? (
        <Notice tone="warning">The IDs are issued, but the labels didn’t print: {error}</Notice>
      ) : null}
      {(job && !isPrintJobActive(job.status)) || error ? (
        <button type="button" onClick={() => void reprint()} disabled={busy}>
          {job ? 'Reprint all labels' : 'Print all labels'}
        </button>
      ) : null}
    </div>
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
