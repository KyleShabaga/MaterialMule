import {
  formatReceiver,
  isPrintJobActive,
  type LabelPreview,
  type PrintJob,
  type Printer,
} from '@materialmule/shared';
import { CircleAlert, FileDown, Printer as PrinterIcon, RotateCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMe } from '../session/context';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { confirmPhysicalPrint, fetchPrinters, requestPrint } from './api';
import { PrintJobStatus } from './PrintJobStatus';
import { usePrintJobs } from './usePrintJobs';

/** Most copies of each label one Print queues (one print job per copy). */
export const MAX_COPIES = 10;

/** Select value for "the server's default printer" when the printer list can't be read. */
const DEFAULT_PRINTER = 'default';

type Printers =
  | { state: 'loading' }
  | { state: 'ready'; printers: Printer[] }
  /** Not an administrator, or the list failed: the server's default printer is used. */
  | { state: 'default'; reason: 'not_admin' | 'error' };

/**
 * The Zebra printers from Settings › Printers. Only administrators can read that list today
 * (`printer.manage`); everyone else prints to the default printer, as before.
 */
function usePrinters(canList: boolean): Printers {
  const [printers, setPrinters] = useState<Printers>(
    canList ? { state: 'loading' } : { state: 'default', reason: 'not_admin' },
  );
  useEffect(() => {
    if (!canList) return;
    let cancelled = false;
    void fetchPrinters().then((result) => {
      if (cancelled) return;
      setPrinters(
        result.ok
          ? { state: 'ready', printers: result.data.filter((printer) => printer.enabled) }
          : { state: 'default', reason: 'error' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [canList]);
  return printers;
}

function parseCopies(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const copies = Number(text);
  return copies >= 1 && copies <= MAX_COPIES ? copies : null;
}

/**
 * The label printing form (STRATA-75): printer, copies, Printed by on a LAB station, then Print
 * (one print job per copy, each recorded on the units' print history) and Save as PDF (the
 * browser's print dialog: never a print job and never recorded as a label print). Printing and
 * Try again never change a storage unit or its ID, and never reconfirm a receipt.
 */
export function LabelPrintForm({
  chosen,
  onSavePdf,
}: {
  /** The labels to print, in order; disposed units are already left out. */
  chosen: LabelPreview[];
  onSavePdf: () => void;
}) {
  const me = useMe();
  const station = useOptionalRecordingPerson();
  // STRATA-125: on a LAB station Printed by is the recording person, read-only; the server
  // re-validates them and records them as they are now. Personal accounts print as themselves.
  const printedBy = station?.isStation ? station.person : null;
  const printers = usePrinters(me.permissions.includes('printer.manage'));
  const [printerChoice, setPrinterChoice] = useState<string | null>(null);
  const [copiesText, setCopiesText] = useState('1');
  const [jobs, setJobs] = usePrintJobs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const printerId = useId();
  const copiesId = useId();
  const copiesErrorId = useId();
  const printedById = useId();

  const listed = printers.state === 'ready' ? printers.printers : [];
  const defaultPrinter = listed.find((printer) => printer.isDefault) ?? listed[0];
  const printerValue =
    printers.state === 'default'
      ? DEFAULT_PRINTER
      : printerChoice && listed.some((printer) => printer.id === printerChoice)
        ? printerChoice
        : (defaultPrinter?.id ?? '');
  const noPrinter = printers.state === 'ready' && listed.length === 0;
  const copies = parseCopies(copiesText);
  const count = chosen.length;

  const active = jobs.some((job) => isPrintJobActive(job.status));
  const failed = jobs.filter((job) => job.status === 'failed');
  const failedJob = failed[0];

  function printRequest(storageUnitIds: string[]) {
    return {
      storageUnitIds,
      kind: 'reprint' as const,
      ...(printerValue && printerValue !== DEFAULT_PRINTER ? { printerId: printerValue } : {}),
      ...(printedBy ? { receiverUserId: printedBy.id } : {}),
    };
  }

  async function print() {
    if (copies === null || count === 0) return;
    setBusy(true);
    setError(null);
    const queued: PrintJob[] = [];
    // One job per copy, one after another, so they print in order.
    for (let copy = 0; copy < copies; copy += 1) {
      const result = await requestPrint(printRequest(chosen.map((label) => label.storageUnitId)));
      if (!result.ok) {
        setError(result.message);
        break;
      }
      queued.push(result.data);
    }
    setBusy(false);
    if (queued.length > 0) setJobs(queued);
  }

  /** A new job for the same units as each failed (or uncertain) one; IDs never change. */
  async function retry(retrying: PrintJob[]) {
    setBusy(true);
    setError(null);
    let next = jobs;
    for (const job of retrying) {
      const result = await requestPrint(printRequest(job.items.map((item) => item.storageUnitId)));
      if (!result.ok) {
        setError(result.message);
        break;
      }
      next = next.map((current) => (current.id === job.id ? result.data : current));
    }
    setBusy(false);
    setJobs(next);
  }

  async function confirm(job: PrintJob) {
    setBusy(true);
    setError(null);
    const result = await confirmPhysicalPrint(job.id);
    setBusy(false);
    if (result.ok) setJobs(jobs.map((current) => (current.id === job.id ? result.data : current)));
    else setError(result.message);
  }

  const printText = count === 1 ? 'Print 1 label' : `Print ${count} labels`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {failedJob ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="line-clamp-none">
            {failedJob.printerMessage
              ? `${failedJob.printerMessage}.`
              : "The printer didn't answer."}
          </AlertTitle>
          <AlertDescription>
            Check that {failedJob.printerName} is switched on and connected to the office network,
            then try again. Or save the {count === 1 ? 'label' : 'labels'} as a PDF.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-4">
        <Field>
          <FieldLabel htmlFor={printerId}>Printer</FieldLabel>
          <Select
            value={printerValue}
            onValueChange={setPrinterChoice}
            disabled={printers.state === 'loading' || noPrinter}
          >
            <SelectTrigger id={printerId} className="w-full">
              <SelectValue
                placeholder={
                  printers.state === 'loading' ? 'Loading printers…' : 'No printer set up'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {printers.state === 'default' ? (
                <SelectItem value={DEFAULT_PRINTER}>Default label printer</SelectItem>
              ) : (
                listed.map((printer) => (
                  <SelectItem key={printer.id} value={printer.id}>
                    {printer.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {noPrinter ? (
            <FieldDescription>
              No label printer is turned on. Add one in{' '}
              <Link to="/settings/printers">Settings › Printers</Link>.
            </FieldDescription>
          ) : printers.state === 'default' ? (
            <FieldDescription>
              {printers.reason === 'error'
                ? "The printer list couldn't be loaded, so the default printer is used."
                : 'The default printer from Settings › Printers.'}
            </FieldDescription>
          ) : null}
        </Field>
        <Field data-invalid={copies === null || undefined}>
          <FieldLabel htmlFor={copiesId}>Copies</FieldLabel>
          <Input
            id={copiesId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_COPIES}
            value={copiesText}
            onChange={(event) => setCopiesText(event.target.value)}
            aria-invalid={copies === null || undefined}
            aria-describedby={copies === null ? copiesErrorId : undefined}
            className="font-mono tabular-nums"
          />
          {copies === null ? (
            <FieldError id={copiesErrorId}>Enter 1 to {MAX_COPIES}.</FieldError>
          ) : (
            <FieldDescription>Of each label</FieldDescription>
          )}
        </Field>
      </div>

      {printedBy ? (
        <Field>
          <FieldLabel htmlFor={printedById}>Printed by</FieldLabel>
          <Input
            id={printedById}
            readOnly
            aria-readonly="true"
            value={formatReceiver(printedBy)}
            aria-describedby={`${printedById}-hint`}
          />
          <FieldDescription id={`${printedById}-hint`}>
            The person in Recording as. To credit someone else, switch person at the top.
          </FieldDescription>
        </Field>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {failed.length > 0 ? (
          <Button type="button" onClick={() => void retry(failed)} disabled={busy}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void print()}
            disabled={busy || active || count === 0 || copies === null || noPrinter}
          >
            <PrinterIcon aria-hidden="true" />
            {printText}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={count === 0} onClick={onSavePdf}>
          <FileDown aria-hidden="true" />
          Save as PDF
        </Button>
        <span className="text-muted-foreground text-sm">A PDF isn&apos;t recorded as a print.</span>
      </div>

      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {jobs.length > 0 ? (
        <section aria-label="Print status" className="flex flex-col gap-3">
          {jobs.map((job, index) => (
            <div key={job.id} className="flex flex-col gap-1">
              {jobs.length > 1 ? (
                <span className="text-muted-foreground text-sm">
                  Copy {index + 1} of {jobs.length}
                </span>
              ) : null}
              <PrintJobStatus
                job={job}
                busy={busy}
                onConfirm={() => void confirm(job)}
                onReprint={job.status === 'uncertain' ? () => void retry([job]) : undefined}
              />
            </div>
          ))}
          <p className="text-muted-foreground m-0 text-sm">
            Each print is recorded on the unit&apos;s print history with who printed it.
          </p>
        </section>
      ) : null}
    </div>
  );
}
