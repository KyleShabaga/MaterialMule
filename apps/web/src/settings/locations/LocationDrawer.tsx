import {
  formatReceiver,
  isPrintJobActive,
  locationKindLabel,
  type LocationDetail,
  type LocationEvent,
  type LocationLabelPreview,
  type PrintJob,
  type ReceiverOption,
} from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ReceiverSelect } from '../../components/ReceiverSelect';
import { DataTable, ErrorState, StatusBadge } from '../../components/ui';
import { confirmPhysicalPrint } from '../../printing/api';
import { PrintJobStatus } from '../../printing/PrintJobStatus';
import { PRINT_POLL_MS } from '../../printing/usePrintJob';
import { useMe } from '../../session/context';
import { fetchLocation, fetchLocationLabelPreview, printLocationLabel } from './api';
import { inventoryLink } from './location-links';
import { Modal } from './Modal';

// A location's label and history (MM-T37): preview, Print label / Reprint through the server
// print queue, honest status, "Labels came out OK", and who did what. Every signed-in person may
// print (label.print); a LAB station names the staff member printing, which is attribution only.

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
    ? formatReceiver({ initials: person.initials, displayName: person.name, position: null })
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

export function LocationDrawer({
  locationId,
  onClose,
  onChanged,
}: {
  locationId: string;
  onClose: () => void;
  /** The list should reload (e.g. the code is now locked). */
  onChanged: () => void;
}) {
  const me = useMe();
  const isLab = me.accountType === 'shared_lab';
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [preview, setPreview] = useState<LocationLabelPreview | null>(null);
  const [reloads, setReloads] = useState(0);
  const [printer, setPrinter] = useState<ReceiverOption | null>(null);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

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
    if (result.ok) {
      onChanged();
    } else {
      setActionError(result.message);
    }
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

  if (load.state !== 'ready') {
    return (
      <Modal title="Location" onClose={onClose}>
        {load.state === 'loading' ? (
          <p aria-busy="true">Loading…</p>
        ) : (
          <ErrorState message={load.message} onRetry={reload} />
        )}
      </Modal>
    );
  }

  const { location, events, printJobs } = load.detail;
  const latest = printJobs[0] ?? null;
  const printing = latest !== null && isPrintJobActive(latest.status);
  return (
    <Modal title={location.name} onClose={onClose}>
      <dl className="details">
        <dt>Code</dt>
        <dd>
          <code>{location.code}</code>
          {location.codeLocked ? ' (locked: on a label)' : ''}
        </dd>
        <dt>Kind</dt>
        <dd>{locationKindLabel(location.kind)}</dd>
        <dt>Area</dt>
        <dd>{location.area ?? '—'}</dd>
        <dt>Status</dt>
        <dd>
          {location.active ? (
            <StatusBadge tone={location.isSystem ? 'info' : 'success'}>
              {location.isSystem ? 'System' : 'Active'}
            </StatusBadge>
          ) : (
            <>
              <StatusBadge tone="neutral">Retired</StatusBadge> {when(location.retiredAt!)} ·{' '}
              {location.retiredReason}
            </>
          )}
        </dd>
        <dt>In stock</dt>
        <dd>
          {location.inStockCount > 0 ? (
            <Link to={inventoryLink(location)}>{location.inStockCount}</Link>
          ) : (
            '0'
          )}
        </dd>
        <dt>Label</dt>
        <dd>
          {location.labelPrintedAt ? (
            <>Confirmed printed {when(location.labelPrintedAt)}</>
          ) : printJobs.length > 0 ? (
            'Sent or queued; not yet confirmed as printed'
          ) : (
            'Not printed yet'
          )}
        </dd>
        <dt>Added</dt>
        <dd>{when(location.createdAt)}</dd>
        <dt>Last changed</dt>
        <dd>{when(location.updatedAt)}</dd>
      </dl>

      <section className="drawer-section" aria-labelledby="location-label-heading">
        <h3 id="location-label-heading">Label</h3>
        {preview ? (
          <figure className="location-label-preview">
            <img
              className="label-image"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`}
              alt={`Location label for ${location.name}, code ${location.code}`}
              width={336}
              height={144}
            />
            <figcaption className="field-hint">
              Both barcodes read <code>{preview.payload}</code>.
              {preview.warnings.length > 0 ? ` ${preview.warnings.join('. ')}.` : ''}
            </figcaption>
          </figure>
        ) : null}
        {location.active ? (
          <div className="print-panel">
            {isLab ? (
              <ReceiverSelect
                label="Printed by"
                required
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
              <button
                type="button"
                className={printJobs.length === 0 ? 'primary' : undefined}
                disabled={busy !== null}
                onClick={() => void print()}
              >
                {busy === 'print'
                  ? 'Sending…'
                  : printJobs.length === 0
                    ? 'Print label'
                    : 'Reprint label'}
              </button>
            ) : null}
            {printJobs.length === 0 ? (
              <p className="field-hint">
                Printing locks the code: after the first print it can’t change, so labels already on
                shelves keep working.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="field-hint">Retired locations can’t be printed.</p>
        )}
        {actionError ? (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </section>

      <section className="drawer-section" aria-labelledby="location-prints-heading">
        <h3 id="location-prints-heading">Print history</h3>
        <div className="table-stack">
          <DataTable
            rows={printJobs}
            rowKey={(job) => job.id}
            caption={`Print history for ${location.code}`}
            empty="No labels printed yet."
            columns={[
              { header: 'Requested', cell: (job) => when(job.createdAt) },
              { header: 'Kind', cell: (job) => (job.kind === 'reprint' ? 'Reprint' : 'Initial') },
              {
                header: 'Label',
                cell: (job) => job.locations.map((item) => item.name).join(', '),
              },
              { header: 'By', cell: requestedBy },
              {
                header: 'Status',
                cell: (job) => (
                  <PrintJobStatus
                    job={job}
                    busy={busy === job.id}
                    onConfirm={() => void confirm(job)}
                  />
                ),
              },
            ]}
          />
        </div>
      </section>

      <section className="drawer-section" aria-labelledby="location-history-heading">
        <h3 id="location-history-heading">Changes</h3>
        {events.length === 0 ? (
          <p className="field-hint">No changes recorded.</p>
        ) : (
          <ol className="location-history">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{EVENT_LABELS[event.action] ?? event.action}</strong>{' '}
                {when(event.occurredAt)} by {personText(event.actor)}
                {event.receiver ? ` for ${personText(event.receiver)}` : ''}
                {changeText(event) ? <div className="field-hint">{changeText(event)}</div> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Modal>
  );
}
