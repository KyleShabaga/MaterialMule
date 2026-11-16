import {
  formatReceiver,
  isPrintJobActive,
  locationKindLabel,
  type LocationDetail,
  type LocationEvent,
  type LocationLabelPreview,
  type PrintJob,
  type ReceiverOption,
  type StorageLocation,
} from '@materialmule/shared';
import { Lock, Printer } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { notifySuccess } from '../../components/strata/toast';
import { confirmPhysicalPrint } from '../../printing/api';
import { PrintJobStatus } from '../../printing/PrintJobStatus';
import { PRINT_POLL_MS } from '../../printing/usePrintJob';
import { useMe } from '../../session/context';
import { fetchLocation, fetchLocationLabelPreview, printLocationLabel } from './api';
import { MANAGE_PERMISSION, inventoryLink, shelfLink } from './location-links';
import { storageUnitsText } from './location-tree';
import { LocationForm } from './LocationForm';
import { RetireLocationDialog } from './RetireLocationDialog';

// One location in the Lab admin › Locations drawer (STRATA-102; canvas locations-drawer and
// locations-system; MM-T37 rules). Everyone signed in sees its details, label and history and may
// print (label.print; a LAB station names the person printing, attribution only). Lab Managers and
// administrators (`location.manage`) also edit it here and retire it. The server enforces both.
//
// TODO(STRATA-106, lane B): the Storage term field ("Short-term"/"Long-term", "Set here" / "From X"
// / "Overrides X") goes under Name once locations carry a storage term. Not built here: the term
// isn't in the API yet, and it must not be guessed from a name.

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; detail: LocationDetail };

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function when(iso: string) {
  return <time dateTime={iso}>{timeFormat.format(new Date(iso))}</time>;
}

function personText(person: { initials: string | null; name: string | null }): string {
  if (!person.name) return person.initials ?? '—';
  return person.initials
    ? formatReceiver({ initials: person.initials, displayName: person.name })
    : person.name;
}

/** "LAB for JS · Jordan Smith": the account, and the staff member credited at the time. */
function requestedBy(job: PrintJob): string {
  const account = job.requestedBy.initials ?? job.requestedBy.name;
  return job.receiver ? `${account} for ${personText(job.receiver)}` : account;
}

const EVENT_LABELS: Record<string, string> = {
  'location.created': 'Added',
  'location.updated': 'Changed',
  'location.retired': 'Retired',
  'location.label_printed': 'Label confirmed printed',
};

function changeText(event: LocationEvent): string {
  if (event.action === 'location.updated' && event.before && event.after) {
    return Object.keys(event.after)
      .map(
        (key) =>
          `${key}: ${String(event.before?.[key] ?? '—')} → ${String(event.after?.[key] ?? '—')}`,
      )
      .join('; ');
  }
  if (event.action === 'location.created' && event.after) {
    return `${String(event.after.code)} · ${String(event.after.name)}`;
  }
  if (event.action === 'location.label_printed' && event.after) {
    return String(event.after.payload ?? '');
  }
  return event.reason ?? '';
}

export function LocationStatusBadge({ location }: { location: StorageLocation }) {
  if (!location.active) return <Badge variant="closed">Retired</Badge>;
  if (location.isSystem) return <Badge variant="secondary">System</Badge>;
  return <Badge variant="storage">Active</Badge>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function LocationDrawer({
  locationId,
  titleId,
  toolbar,
  inSheet = false,
  onChanged,
}: {
  locationId: string;
  /** ID for the drawer's title, which names the drawer region (or the sheet). */
  titleId: string;
  /** The drawer toolbar (Previous, Next, Close), from the page that knows the order. */
  toolbar: ReactNode;
  /** On phones and tablets the drawer is a Sheet, whose title must be the dialog's title. */
  inSheet?: boolean;
  /** The list should reload (a save, a retirement, a code now locked by a print). */
  onChanged: () => void;
}) {
  const me = useMe();
  const canManage = me.permissions.includes(MANAGE_PERMISSION);
  const isLab = me.accountType === 'shared_lab';
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [preview, setPreview] = useState<LocationLabelPreview | null>(null);
  const [reloads, setReloads] = useState(0);
  const [printer, setPrinter] = useState<ReceiverOption | null>(null);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  const retireRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchLocation(locationId).then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', detail: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, reloads]);

  // The preview follows the name: fetch it again whenever the location's version changes.
  const version = load.state === 'ready' ? load.detail.location.version : null;
  useEffect(() => {
    if (version === null) return;
    let cancelled = false;
    void fetchLocationLabelPreview(locationId).then((result) => {
      if (!cancelled) setPreview(result.ok ? result.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [locationId, version]);

  // Keep statuses live while any job is still with the worker.
  const anyActive =
    load.state === 'ready' && load.detail.printJobs.some((job) => isPrintJobActive(job.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setTimeout(reload, PRINT_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyActive, reloads, reload]);

  async function print() {
    setActionError(null);
    if (isLab && !printer) {
      setPrinterError('Choose who is printing this label.');
      return;
    }
    setPrinterError(null);
    setBusy('print');
    const result = await printLocationLabel(
      locationId,
      isLab && printer ? { receiverUserId: printer.id } : {},
    );
    setBusy(null);
    if (result.ok) onChanged();
    else setActionError(result.message);
    reload();
  }

  async function confirm(job: PrintJob) {
    setBusy(job.id);
    setActionError(null);
    const result = await confirmPhysicalPrint(job.id);
    setBusy(null);
    if (!result.ok) setActionError(result.message);
    else onChanged();
    reload();
  }

  function conflict(current: StorageLocation, message: string) {
    // Someone else saved first: show the latest values and say so.
    setRetiring(false);
    setNotice(`${message} This now shows the latest details for ${current.name}.`);
    reload();
    onChanged();
  }

  const Title = inSheet ? SheetTitle : 'h2';
  // In a Sheet, Radix gives the title its own id (an explicit id, even undefined, would break it).
  const titleProps = inSheet ? {} : { id: titleId };

  if (load.state !== 'ready') {
    return (
      <>
        {toolbar}
        <div className="grid gap-4 p-6">
          <Title {...titleProps} className="text-lg font-semibold">
            Location
          </Title>
          {load.state === 'loading' ? (
            <div aria-busy="true" className="grid gap-2">
              <span className="sr-only">Loading…</span>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                {load.message}
                <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={reload}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </>
    );
  }

  const { location, events, printJobs } = load.detail;
  const latest = printJobs[0] ?? null;
  const printing = latest !== null && isPrintJobActive(latest.status);
  const editable = canManage && location.active;
  const Description = inSheet ? SheetDescription : 'p';

  return (
    <>
      {toolbar}
      <div className="grid gap-6 p-6">
        <header className="grid gap-1">
          <Description className="text-sm text-muted-foreground">
            {location.isSystem ? 'System location' : (location.area ?? 'No area')}
          </Description>
          <div className="flex flex-wrap items-center gap-2">
            <Title {...titleProps} className="text-lg font-semibold">
              {location.name}
            </Title>
            <LocationStatusBadge location={location} />
          </div>
        </header>

        {notice ? (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <dl className="grid">
          <Fact term="Code">
            <span className="inline-flex items-center gap-1.5 font-mono">
              {location.code}
              {location.codeLocked || location.isSystem ? (
                <Lock aria-hidden="true" className="size-3.5 text-muted-foreground" />
              ) : null}
            </span>
            {location.isSystem ? (
              <p className="text-muted-foreground">The system location’s code can’t change.</p>
            ) : location.codeLocked ? (
              <p className="text-muted-foreground">
                A label has been printed or queued for this code, so it can’t change.
              </p>
            ) : null}
          </Fact>
          <Fact term="Kind">{locationKindLabel(location.kind)}</Fact>
          <Fact term="In stock">
            {location.inStockCount > 0 ? (
              <Link
                className="text-link underline-offset-4 hover:underline"
                to={inventoryLink(location)}
              >
                {storageUnitsText(location.inStockCount)}
              </Link>
            ) : (
              'None'
            )}
            {' · '}
            <Link className="text-link underline-offset-4 hover:underline" to={shelfLink(location)}>
              Open shelf page
            </Link>
            {location.isSystem ? (
              <p className="text-muted-foreground">
                Units wait here after receiving until they’re put away. It can’t be retired.
              </p>
            ) : null}
          </Fact>
          <Fact term="Label">
            {location.labelPrintedAt ? (
              <>Confirmed printed {when(location.labelPrintedAt)}</>
            ) : printJobs.length > 0 ? (
              'Sent or queued; not yet confirmed as printed'
            ) : (
              'Not printed yet'
            )}
          </Fact>
          {!location.active && location.retiredAt ? (
            <Fact term="Retired">
              {when(location.retiredAt)}
              {location.retiredReason ? ` · ${location.retiredReason}` : ''}
            </Fact>
          ) : null}
          <Fact term="Added">{when(location.createdAt)}</Fact>
          <Fact term="Last changed">{when(location.updatedAt)}</Fact>
        </dl>

        {editable ? (
          <>
            <Separator />
            <LocationForm
              // A newer saved version (or a code locked by a print) starts the form again.
              key={`${location.version}:${location.codeLocked}`}
              location={location}
              submitLabel="Save changes"
              onConflict={conflict}
              onSaved={(_saved, message) => {
                setNotice(null);
                notifySuccess(message);
                reload();
                onChanged();
              }}
              footer={(submit) => (
                <div className="flex flex-wrap gap-2">
                  {submit}
                  {location.isSystem ? null : (
                    <Button
                      ref={retireRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRetiring(true)}
                    >
                      Retire location…
                    </Button>
                  )}
                </div>
              )}
            />
          </>
        ) : null}

        <Separator />
        <Section id={`${titleId}-label`} title="Label">
          {preview ? (
            <figure className="m-0 grid gap-2">
              {/* Real size (3.5 × 1.5 in) where it fits; narrower drawers scale it down. */}
              <img
                className="h-auto w-[3.5in] max-w-full rounded-md border bg-white"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`}
                alt={`Location label for ${location.name}, code ${location.code}`}
                width={336}
                height={144}
              />
              <figcaption className="text-sm text-muted-foreground">
                Both barcodes read <code className="font-mono">{preview.payload}</code>.
                {preview.warnings.length > 0 ? ` ${preview.warnings.join('. ')}.` : ''}
              </figcaption>
            </figure>
          ) : null}
          {location.active ? (
            <div className="grid gap-3">
              {isLab ? (
                <ReceiverSelect
                  label="Printed by"
                  required
                  stationPerson="follow"
                  value={printer}
                  onChange={(option) => {
                    setPrinter(option);
                    setPrinterError(null);
                  }}
                  error={printerError}
                />
              ) : null}
              {latest ? (
                <PrintJobStatus
                  job={latest}
                  busy={busy === latest.id}
                  onConfirm={() => void confirm(latest)}
                />
              ) : null}
              {!printing ? (
                <Button
                  type="button"
                  size="sm"
                  variant={printJobs.length === 0 ? 'default' : 'outline'}
                  className="w-fit"
                  disabled={busy !== null}
                  onClick={() => void print()}
                >
                  <Printer aria-hidden="true" />
                  {busy === 'print'
                    ? 'Sending…'
                    : printJobs.length === 0
                      ? 'Print label'
                      : 'Reprint label'}
                </Button>
              ) : null}
              {printJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Printing locks the code: after the first print it can’t change, so labels already
                  on shelves keep working.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Retired locations can’t be printed.</p>
          )}
          {actionError ? <FieldError>{actionError}</FieldError> : null}
        </Section>

        <Section id={`${titleId}-prints`} title="Print history">
          {printJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No labels printed yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="text-sm">
                <TableCaption className="sr-only">Print history for {location.code}</TableCaption>
                <TableHeader className="bg-muted">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Requested</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {printJobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="whitespace-nowrap">{when(job.createdAt)}</TableCell>
                      <TableCell>{job.kind === 'reprint' ? 'Reprint' : 'Initial'}</TableCell>
                      <TableCell className="whitespace-normal">{requestedBy(job)}</TableCell>
                      <TableCell className="whitespace-normal">
                        <PrintJobStatus
                          job={job}
                          busy={busy === job.id}
                          onConfirm={() => void confirm(job)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        <Section id={`${titleId}-changes`} title="Changes">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes recorded.</p>
          ) : (
            <ol className="grid gap-3 text-sm">
              {events.map((event) => (
                <li key={event.id} className="grid gap-0.5">
                  <span>
                    <span className="font-medium">
                      {EVENT_LABELS[event.action] ?? event.action}
                    </span>{' '}
                    by {personText(event.actor)}
                    {event.receiver ? ` for ${personText(event.receiver)}` : ''}
                  </span>
                  <span className="text-muted-foreground">{when(event.occurredAt)}</span>
                  {changeText(event) ? (
                    <span className="text-muted-foreground">{changeText(event)}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      {retiring ? (
        <RetireLocationDialog
          location={location}
          returnFocus={retireRef}
          onClose={() => setRetiring(false)}
          onConflict={conflict}
          onRetired={(retired) => {
            setRetiring(false);
            setNotice(null);
            notifySuccess(`${retired.name} was retired.`);
            reload();
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}
