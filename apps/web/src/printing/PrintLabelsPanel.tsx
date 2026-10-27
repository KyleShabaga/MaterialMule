import { isPrintJobActive, type PrintJob, type PrintJobKind } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { confirmPhysicalPrint, requestPrint } from './api';
import { PrintJobStatus } from './PrintJobStatus';
import { usePrintJob } from './usePrintJob';

/**
 * Print button with live status for a set of storage units, e.g. "Print all" on the labels step
 * after confirming a receipt (MM-T10) or "Reprint label" on a unit's page. Printing never
 * changes the units; a reprint is a new job for the same issued IDs.
 */
export function PrintLabelsPanel({
  storageUnitIds,
  kind,
  buttonLabel,
  onJobChange,
}: {
  storageUnitIds: string[];
  kind: PrintJobKind;
  buttonLabel: string;
  /** Called whenever the job shown here changes (queued, status update, confirmation). */
  onJobChange?: (job: PrintJob) => void;
}) {
  const [job, setJob] = usePrintJob();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job) onJobChange?.(job);
  }, [job, onJobChange]);

  async function print(printKind: PrintJobKind) {
    setBusy(true);
    setError(null);
    const result = await requestPrint({ storageUnitIds, kind: printKind });
    setBusy(false);
    if (result.ok) setJob(result.data);
    else setError(result.message);
  }

  async function confirm() {
    if (!job) return;
    setBusy(true);
    setError(null);
    const result = await confirmPhysicalPrint(job.id);
    setBusy(false);
    if (result.ok) setJob(result.data);
    else setError(result.message);
  }

  return (
    <div className="print-panel">
      {job ? <PrintJobStatus job={job} busy={busy} onConfirm={() => void confirm()} /> : null}
      {!job || !isPrintJobActive(job.status) ? (
        <button
          type="button"
          className={job ? undefined : 'primary'}
          onClick={() => void print(job ? 'reprint' : kind)}
          disabled={busy || storageUnitIds.length === 0}
        >
          {job ? 'Reprint' : buttonLabel}
        </button>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
