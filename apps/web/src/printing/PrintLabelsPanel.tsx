import { isPrintJobActive, type PrintJob, type PrintJobKind } from '@materialmule/shared';
import { Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
  printerId,
  receiverUserId,
}: {
  storageUnitIds: string[];
  kind: PrintJobKind;
  buttonLabel: string;
  /** Called whenever the job shown here changes (queued, status update, confirmation). */
  onJobChange?: (job: PrintJob) => void;
  /** A configured printer's key; the server's default printer when left out. */
  printerId?: string;
  /**
   * The person credited at a LAB station (the recording person, STRATA-125). Left out, the server
   * credits the receipt's receiver; personal accounts are always credited as themselves.
   */
  receiverUserId?: string;
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
    const result = await requestPrint({
      storageUnitIds,
      kind: printKind,
      ...(printerId ? { printerId } : {}),
      ...(receiverUserId ? { receiverUserId } : {}),
    });
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
    <div className="print-panel flex flex-col items-start gap-3">
      {job ? <PrintJobStatus job={job} busy={busy} onConfirm={() => void confirm()} /> : null}
      {!job || !isPrintJobActive(job.status) ? (
        <Button
          type="button"
          variant={job ? 'outline' : 'default'}
          onClick={() => void print(job ? 'reprint' : kind)}
          disabled={busy || storageUnitIds.length === 0}
        >
          <Printer aria-hidden="true" />
          {job ? 'Reprint' : buttonLabel}
        </Button>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
