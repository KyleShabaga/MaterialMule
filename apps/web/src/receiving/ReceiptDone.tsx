import { isPrintJobActive, type ConfirmReceiptResponse, type PrintJob } from '@materialmule/shared';
import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  FileDown,
  Printer,
  ScanLine,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { confirmPhysicalPrint, requestPrint } from '../printing/api';
import { PrintJobStatus } from '../printing/PrintJobStatus';
import { receiptPrintPath } from '../printing/print-paths';
import { usePrintJob } from '../printing/usePrintJob';
import type { MoveLinkState } from '../moves/move-link';
import { VerifyLabelsPanel } from '../scanning/VerifyLabelsPanel';
import { useAfterReceipt } from './after-receipt';
import { UNIT_KIND_LABEL, unitContentLines, unitKindOf, type ReceiptDraft } from './draft';

/** Put away is the Move screen with the receipt's units waiting for their shelf (lane C). */
export const PUT_AWAY_PATH = '/sample-storage/move';

/**
 * Receipt confirmed (STRATA-77): "n storage units received", each new ID large in mono with its
 * label status ("Sent to printer", never "Printed": only a person can say it came out), then the
 * two physical steps: stick each label on its unit, then put them away (primary). If the labels
 * didn't print, or it isn't known, Print again becomes the primary; it never confirms again.
 *
 * Labels are sent once when the page opens. With the preference "Go straight to Put away", the
 * page opens Put away as soon as the labels are sent; a failed or uncertain print stops here.
 */
export function ReceiptDone({
  draft,
  result,
  onReceiveAnother,
}: {
  draft: ReceiptDraft;
  result: ConfirmReceiptResponse;
  onReceiveAnother: () => void;
}) {
  const navigate = useNavigate();
  const afterReceipt = useAfterReceipt();
  const rows = draft.units.map((unit) => ({
    unit,
    issued: result.units.find((u) => u.clientRowId === unit.clientRowId),
  }));
  const ids = result.units.map((u) => u.storageUnitId);
  const readableIds = result.units.map((u) => u.suNumber);
  const count = result.units.length;
  const print = useReceiptPrint(result.receiptId, ids);
  const [verifying, setVerifying] = useState(false);
  const moveState = { units: readableIds } satisfies MoveLinkState;

  const job = print.job;
  const failed = print.error !== null || job?.status === 'failed' || job?.status === 'uncertain';
  const sending = !failed && (job === null || isPrintJobActive(job.status));

  // "Go straight to Put away": only once the labels are sent; never past a failed print.
  const left = useRef(false);
  useEffect(() => {
    if (left.current || afterReceipt !== 'put_away' || job?.status !== 'sent') return;
    left.current = true;
    void navigate(PUT_AWAY_PATH, { state: moveState });
  });

  const project = draft.project
    ? `${draft.project.projectNumber} ${draft.project.name}`
    : 'No project';
  const receivedBy = draft.receiver?.displayName ?? '';
  const labelsText = count === 1 ? '1 label' : `${count} labels`;

  const printAgain = (primary: boolean) => (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      onClick={() => void print.again()}
      disabled={print.busy || sending}
    >
      <Printer aria-hidden="true" />
      {primary ? 'Print again' : 'Print all labels again'}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-3">
        <CircleCheck aria-hidden="true" className="text-stage-storage-fg mt-1 size-6 shrink-0" />
        <div className="grid min-w-0 gap-1">
          <h1
            id="receipt-done-heading"
            tabIndex={-1}
            className="m-0 text-2xl font-semibold tracking-tight outline-none"
          >
            {count === 1 ? '1 storage unit received' : `${count} storage units received`}
          </h1>
          <p className="text-muted-foreground m-0 text-sm">
            {project} · received <span className="font-mono">{draft.receivedDate}</span>
            {receivedBy ? ` by ${receivedBy}` : ''}
          </p>
        </div>
      </header>

      <div role="status" aria-live="polite">
        {sending ? (
          <p className="text-muted-foreground m-0 flex items-center gap-2 text-sm">
            <Spinner aria-hidden="true" role="presentation" />
            Sending the labels to the printer… {labelsText}.
          </p>
        ) : null}
      </div>
      {failed ? (
        <Alert
          variant="destructive"
          className="relative overflow-hidden pl-5 has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr]"
        >
          <span aria-hidden="true" className="bg-stage-danger-mark absolute inset-y-0 left-0 w-1" />
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="line-clamp-none">
            {job?.status === 'uncertain'
              ? 'The IDs are issued, but it isn’t known whether the labels printed.'
              : 'The IDs are issued, but the labels didn’t print.'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {print.error ??
                job?.printerMessage ??
                'Check that the printer is on and has labels, then print again.'}{' '}
              The IDs stay the same.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {printAgain(true)}
              <Button asChild variant="outline" className="text-foreground">
                <Link to={receiptPrintPath(result.receiptId)} target="_blank" rel="noopener">
                  <FileDown aria-hidden="true" />
                  Save as PDF
                </Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="done-stick" className="bg-card rounded-xl border p-5">
        <div className="flex items-start gap-3">
          <StepNumber n={1} />
          <div className="grid min-w-0 flex-1 gap-1">
            <h2 id="done-stick" className="m-0 text-base font-semibold">
              Stick each label on its unit
            </h2>
            <p className="text-muted-foreground m-0 text-sm">
              Match the holder and the test hole or location on the label to the bucket, tube or
              box.
            </p>
          </div>
        </div>
        <ul aria-label="New storage units" className="m-0 mt-4 flex list-none flex-col p-0">
          {rows.map(({ unit, issued }) => (
            <li
              key={unit.clientRowId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3 first:border-t-0"
            >
              <div className="grid min-w-0 flex-1 basis-72 gap-0.5">
                <h3 className="m-0 font-mono text-xl font-semibold tracking-tight whitespace-nowrap">
                  {issued?.suNumber ?? '—'}
                </h3>
                <p className="text-muted-foreground m-0 text-sm">
                  {UNIT_KIND_LABEL[unitKindOf(unit)]} ·{' '}
                  <span className="font-mono">
                    {unitContentLines(draft, unit)
                      .map((line) => `${line.hole} ${line.text}`)
                      .join('; ')}
                  </span>
                </p>
              </div>
              <LabelState job={job} failed={failed} />
              {issued ? (
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/sample-storage/${encodeURIComponent(issued.suNumber)}`}>
                    Open {issued.suNumber}
                  </Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {job ? (
          <div className="mt-3 border-t pt-3">
            <PrintJobStatus job={job} busy={print.busy} onConfirm={() => void print.confirm()} />
          </div>
        ) : null}
        {verifying ? (
          <div className="mt-3">
            <VerifyLabelsPanel expectedIds={readableIds} onClose={() => setVerifying(false)} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="done-put-away" className="bg-card rounded-xl border p-5">
        <div className="flex items-start gap-3">
          <StepNumber n={2} />
          <div className="grid min-w-0 flex-1 gap-1">
            <h2 id="done-put-away" className="m-0 text-base font-semibold">
              Put them away
            </h2>
            <p className="text-muted-foreground m-0 text-sm">
              Scan the units and the shelf, in either order. Units not put away wait at Receiving
              until they are shelved.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant={failed ? 'outline' : 'default'}>
            <Link to={PUT_AWAY_PATH} state={moveState}>
              <ArrowDownToLine aria-hidden="true" />
              Put away
            </Link>
          </Button>
          {failed ? null : printAgain(false)}
          <Button type="button" variant="outline" onClick={onReceiveAnother}>
            Receive more
          </Button>
          {verifying ? null : (
            <Button type="button" variant="ghost" onClick={() => setVerifying(true)}>
              <ScanLine aria-hidden="true" />
              Verify labels
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link to={receiptPrintPath(result.receiptId)} target="_blank" rel="noopener">
              Print / Save all labels as PDF
            </Link>
          </Button>
        </div>
        <Separator className="my-4" />
        <p className="text-muted-foreground m-0 text-[13px]">
          Want to skip this page? Settings › Preferences › Receiving can go straight to Put away
          after confirming. <Link to="/receiving-log">Back to the receiving log</Link>
        </p>
      </section>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-[13px] font-semibold"
    >
      {n}
    </span>
  );
}

/** One unit's label, as far as the app knows: never "Printed" until a person says so. */
function LabelState({ job, failed }: { job: PrintJob | null; failed: boolean }) {
  if (failed) {
    return (
      <Badge variant="danger" className="h-6 px-2.5 text-[13px] font-semibold">
        <TriangleAlert aria-hidden="true" />
        {job?.status === 'uncertain' ? 'Not known' : 'Not printed'}
      </Badge>
    );
  }
  if (!job || isPrintJobActive(job.status)) {
    return (
      <Badge variant="secondary" className="h-6 px-2.5 text-[13px] font-semibold">
        Sending…
      </Badge>
    );
  }
  return (
    <Badge variant="storage" className="h-6 px-2.5 text-[13px] font-semibold">
      <Printer aria-hidden="true" />
      Sent to printer
    </Badge>
  );
}

/** One request per receipt, even if this page mounts twice (StrictMode, a quick remount). */
const autoPrints = new Map<string, ReturnType<typeof requestPrint>>();

/**
 * Sends every label once when the page opens and follows the job. Print again sends a reprint
 * of the same issued IDs (or the first print, if the first request never made a job): the
 * receipt is never confirmed again.
 */
function useReceiptPrint(receiptId: string, storageUnitIds: string[]) {
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

  async function again() {
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

  return { job, busy, error, again, confirm };
}
