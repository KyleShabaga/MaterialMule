import { isPrintJobActive, type PrintHistoryResponse, type PrintJob } from '@trapezoid/shared';
import { useCallback, useEffect, useState } from 'react';
import { DataTable, ErrorState } from '../components/ui';
import { confirmPhysicalPrint, fetchPrintHistory } from './api';
import { PrintJobStatus } from './PrintJobStatus';
import { PrintLabelsPanel } from './PrintLabelsPanel';
import { PRINT_POLL_MS } from './usePrintJob';

type History =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; history: PrintHistoryResponse };

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function who(job: PrintJob): string {
  const account = job.requestedBy.initials ?? job.requestedBy.name;
  const receiver = job.receiver ? ` for ${job.receiver.initials ?? job.receiver.name}` : '';
  return `${account}${receiver}`;
}

/**
 * Labels section of the storage unit detail page (TRP-T15, placed on the page by TRP-T12): print
 * or reprint the unit's label and its print history.
 */
export function StorageUnitLabelsSection({ readableId }: { readableId: string }) {
  const [history, setHistory] = useState<History>({ state: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    void fetchPrintHistory(readableId).then((result) => {
      if (cancelled) return;
      setHistory(
        result.ok
          ? { state: 'ready', history: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [readableId, reloads]);

  // Keep statuses live while any job is still with the worker.
  const anyActive =
    history.state === 'ready' && history.history.jobs.some((job) => isPrintJobActive(job.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setTimeout(reload, PRINT_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyActive, reloads, reload]);

  async function confirm(job: PrintJob) {
    setBusyJob(job.id);
    setActionError(null);
    const result = await confirmPhysicalPrint(job.id);
    setBusyJob(null);
    if (!result.ok) setActionError(result.message);
    reload();
  }

  if (history.state === 'loading') {
    return (
      <section className="card" aria-labelledby="labels-heading" id="labels">
        <h2 id="labels-heading">Label</h2>
        <p aria-busy="true">Loading…</p>
      </section>
    );
  }
  if (history.state === 'error') {
    return (
      <section className="card" aria-labelledby="labels-heading" id="labels">
        <h2 id="labels-heading">Label</h2>
        <ErrorState message={history.message} onRetry={reload} />
      </section>
    );
  }

  const { storageUnit, jobs } = history.history;
  return (
    <>
      <section className="card" aria-labelledby="labels-heading" id="labels">
        <h2 id="labels-heading">Label</h2>
        <PrintLabelsPanel
          key={storageUnit.id}
          storageUnitIds={[storageUnit.id]}
          kind={jobs.length > 0 ? 'reprint' : 'initial'}
          buttonLabel={jobs.length > 0 ? 'Reprint label' : 'Print label'}
          onJobChange={reload}
        />
      </section>
      <section className="card" aria-labelledby="print-history-heading">
        <h2 id="print-history-heading">Print history</h2>
        {actionError ? (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        ) : null}
        <DataTable
          rows={jobs}
          rowKey={(job) => job.id}
          caption={`Print history for ${storageUnit.readableId}`}
          empty="No labels printed yet."
          columns={[
            {
              header: 'Requested',
              cell: (job) => (
                <time dateTime={job.createdAt}>{timeFormat.format(new Date(job.createdAt))}</time>
              ),
            },
            { header: 'Kind', cell: (job) => (job.kind === 'reprint' ? 'Reprint' : 'Initial') },
            { header: 'By', cell: who },
            { header: 'Printer', cell: (job) => job.printerName },
            {
              header: 'Status',
              cell: (job) => (
                <PrintJobStatus
                  job={job}
                  busy={busyJob === job.id}
                  onConfirm={() => void confirm(job)}
                />
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
