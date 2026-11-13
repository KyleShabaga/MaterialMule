import {
  formatReceiver,
  isPrintJobActive,
  type PrintHistoryResponse,
  type PrintJob,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

/**
 * "LAB for JS · Jordan Smith": the account, and the receiver as they were when the job was
 * requested (MM-T65) with initials and name, so people sharing initials are told apart (MM-T61).
 */
function who(job: PrintJob): string {
  const account = job.requestedBy.initials ?? job.requestedBy.name;
  if (!job.receiver) return account;
  const { initials, name } = job.receiver;
  const receiver = initials ? formatReceiver({ initials, displayName: name }) : name;
  return `${account} for ${receiver}`;
}

/**
 * Labels section of the storage unit detail page (MM-T15, placed on the page by MM-T12): print
 * or reprint the unit's label and its print history. A disposed unit's ID never gets a fresh
 * sticker (MM-T77; the server refuses it too), but its print history stays readable.
 */
export function StorageUnitLabelsSection({
  readableId,
  disposed = false,
}: {
  readableId: string;
  disposed?: boolean;
}) {
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
      <SectionCard id="labels" title="Label">
        <p aria-busy="true" className="text-muted-foreground m-0 text-sm">
          Loading…
        </p>
      </SectionCard>
    );
  }
  if (history.state === 'error') {
    return (
      <SectionCard id="labels" title="Label">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{history.message}</span>
            <Button type="button" variant="outline" onClick={reload}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </SectionCard>
    );
  }

  const { storageUnit, jobs } = history.history;
  return (
    <>
      <SectionCard id="labels" title="Label">
        {disposed ? (
          <p className="m-0 text-sm">
            This storage unit is disposed; its label is not printed again.
          </p>
        ) : (
          <PrintLabelsPanel
            key={storageUnit.id}
            storageUnitIds={[storageUnit.id]}
            kind={jobs.length > 0 ? 'reprint' : 'initial'}
            buttonLabel={jobs.length > 0 ? 'Reprint label' : 'Print label'}
            onJobChange={reload}
          />
        )}
      </SectionCard>
      <SectionCard title="Print history">
        {actionError ? (
          <Alert variant="destructive">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
        {jobs.length === 0 ? (
          <p className="text-muted-foreground m-0 rounded-xl border border-dashed px-4 py-6 text-sm">
            No labels printed yet.
          </p>
        ) : (
          <Table>
            <TableCaption className="sr-only">
              Print history for {storageUnit.readableId}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Requested</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id} className="align-top">
                  <TableCell>
                    <time dateTime={job.createdAt}>
                      {timeFormat.format(new Date(job.createdAt))}
                    </time>
                  </TableCell>
                  <TableCell>{job.kind === 'reprint' ? 'Reprint' : 'Initial'}</TableCell>
                  <TableCell className="whitespace-normal">{who(job)}</TableCell>
                  <TableCell className="whitespace-normal">{job.printerName}</TableCell>
                  <TableCell className="whitespace-normal">
                    <PrintJobStatus
                      job={job}
                      busy={busyJob === job.id}
                      onConfirm={() => void confirm(job)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </>
  );
}

/** A Strata card that is a page section (a labelled region), as the unit page lays them out. */
function SectionCard({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className="min-w-0">
      <Card className="gap-4 shadow-none">
        <CardHeader>
          <CardTitle>
            <h2 id={headingId} className="m-0 text-base font-semibold">
              {title}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">{children}</CardContent>
      </Card>
    </section>
  );
}
