import {
  formatPerson,
  locationKindLabel,
  type InventoryItem,
  type InventoryPage,
  type LocationActivity,
  type LocationDetail,
  type PrintJob,
} from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  CountedCells,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionHead,
  StatusBadge,
  type CountedCellState,
} from '../components/ui';
import { ContextRow } from '../layout/ContextRow';
import { usePageTitle } from '../layout/page-title';
import { moveToPath } from '../moves/move-link';
import { PrintJobStatus } from '../printing/PrintJobStatus';
import { useMe } from '../session/context';
import { printLocationLabel } from '../settings/locations/api';
import {
  fetchInventory,
  fetchLocationActivity,
  fetchLocationDetail,
  resolveLocationCode,
} from './api';
import './inventory.css';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';
import { UnitContentsLine } from './UnitContents';

/** Units listed on one shelf page; the count and cells still use the full total. */
const SHELF_PAGE_SIZE = 100;

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

type Shelf =
  | { state: 'loading'; key: string }
  | { state: 'missing'; key: string }
  | { state: 'error'; key: string; message: string }
  | {
      state: 'ready';
      key: string;
      detail: LocationDetail;
      units: InventoryPage;
      activity: LocationActivity;
    };

/** Due for disposal by date: drawn as a flag cell ("due for retention"). */
function isDue(item: InventoryItem) {
  return Boolean(
    item.retention && !item.retention.retentionExempt && item.retention.eligibleByDate,
  );
}

/**
 * Shelf (Field Ledger): where a scanned shelf label lands. The location as a label-like block
 * with one counted cell per unit stored on it (ink stored, flag due for retention), the units on
 * it, and the last 30 days of comings and goings. Locations record no capacity, so there are no
 * empty cells: the cells count what is there, never free space.
 */
export function ShelfPage() {
  const { code = '' } = useParams();
  usePageTitle(code);
  const me = useMe();
  const [reloads, setReloads] = useState(0);
  const key = `${code}:${reloads}`;
  const [shelf, setShelf] = useState<Shelf>({ state: 'loading', key });

  useEffect(() => {
    let cancelled = false;
    const done = (next: Shelf) => {
      if (!cancelled) setShelf(next);
    };
    void (async () => {
      const resolved = await resolveLocationCode(code);
      if (!resolved.ok) return done({ state: 'error', key, message: resolved.message });
      if (!resolved.data) return done({ state: 'missing', key });
      const id = resolved.data.id;
      const params = new URLSearchParams({
        locationId: id,
        status: 'current',
        pageSize: String(SHELF_PAGE_SIZE),
      });
      const [detail, units, activity] = await Promise.all([
        fetchLocationDetail(id),
        fetchInventory(params),
        fetchLocationActivity(id),
      ]);
      if (!detail.ok) {
        return detail.notFound
          ? done({ state: 'missing', key })
          : done({ state: 'error', key, message: detail.message });
      }
      if (!units.ok) return done({ state: 'error', key, message: units.message });
      if (!activity.ok) return done({ state: 'error', key, message: activity.message });
      done({
        state: 'ready',
        key,
        detail: detail.data,
        units: units.data,
        activity: activity.data,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [code, key]);

  const back = <Link to="/sample-storage">← Back to inventory</Link>;

  if (shelf.key !== key || shelf.state === 'loading') {
    return (
      <>
        <ContextRow>{back}</ContextRow>
        <PageHeader title={code} documentTitle={false} />
        <p aria-busy="true">Loading…</p>
      </>
    );
  }
  if (shelf.state === 'missing') {
    return (
      <>
        <ContextRow>{back}</ContextRow>
        <PageHeader title={code} documentTitle={false} />
        <EmptyState title="No location has this code.">
          Check the label, or find the unit in Inventory.
        </EmptyState>
      </>
    );
  }
  if (shelf.state === 'error') {
    return (
      <>
        <ContextRow>{back}</ContextRow>
        <PageHeader title={code} documentTitle={false} />
        <ErrorState message={shelf.message} onRetry={() => setReloads((n) => n + 1)} />
      </>
    );
  }

  const { location } = shelf.detail;
  const items = shelf.units.items;
  const total = shelf.units.total;
  const due = items.filter(isDue).length;
  const cells: CountedCellState[] = [
    ...Array<CountedCellState>(due).fill('current'),
    ...Array<CountedCellState>(Math.max(0, total - due)).fill('done'),
  ];
  const arrivals = new Map(shelf.activity.arrivals.map((a) => [a.storageUnitId, a.arrivedAt]));
  const projects = [...new Set(items.map((item) => item.project.projectNumber))].sort();
  const lastChange = shelf.activity.movements[0]?.occurredAt ?? null;

  return (
    <>
      <ContextRow>
        {back}
        <span className="unit-context-actions">
          {me.accountType === 'shared_lab' || !location.active ? null : (
            <PrintShelfLabel locationId={location.id} />
          )}
          {location.active ? (
            <Link className="button primary" to={moveToPath(location.code)}>
              Move units here
            </Link>
          ) : null}
        </span>
      </ContextRow>

      <div className="unit-layout">
        <div className="unit-side">
          <div className="unit-label shelf-label">
            <div className="unit-label-head">
              <span className="unit-label-holder">Shelf</span>
              <span className="unit-label-project">{locationKindLabel(location.kind)}</span>
            </div>
            <div className="shelf-label-cells">
              <div className="shelf-label-cell">
                <span className="field-label">{location.area ? 'Area' : 'Code'}</span>
                <span className="shelf-label-value">{location.area ?? location.code}</span>
              </div>
              <div className="shelf-label-cell where-cell-current">
                <span className="field-label">Location</span>
                <h1 className="shelf-label-value">{location.name}</h1>
              </div>
            </div>
            <div className="shelf-label-fill">
              <div className="shelf-label-fill-head">
                <span className="field-label">Units here</span>
                <span className="mono">
                  {total} {due > 0 ? `· ${due} due for retention` : ''}
                </span>
              </div>
              {total > 0 ? (
                <CountedCells
                  cells={cells}
                  label={`${total} ${total === 1 ? 'unit' : 'units'} on this shelf, ${due} due for retention`}
                />
              ) : null}
              <p className="field-hint">
                Black is stored, orange is due for retention. Shelf capacity isn’t recorded.
              </p>
            </div>
          </div>

          <dl className="fact-list unit-facts">
            <Fact term="Code">
              <span className="mono">{location.code}</span>
              {location.active ? null : (
                <>
                  {' '}
                  <StatusBadge tone="closed">Retired</StatusBadge>
                </>
              )}
            </Fact>
            <Fact term="Label last printed">
              {location.labelPrintedAt
                ? dateFormat.format(new Date(location.labelPrintedAt))
                : 'Not yet'}
            </Fact>
            <Fact term="Projects here">{projects.length > 0 ? projects.join(', ') : 'None'}</Fact>
            <Fact term="Last change">
              {lastChange ? timeFormat.format(new Date(lastChange)) : 'None in 30 days'}
            </Fact>
          </dl>
        </div>

        <div className="unit-main">
          <section className="unit-section" aria-labelledby="shelf-units-heading">
            <SectionHead
              id="shelf-units-heading"
              title="On this shelf"
              meta={`${total} ${total === 1 ? 'unit' : 'units'}`}
            />
            {items.length === 0 ? (
              <EmptyState title="Nothing is stored here.">
                Scan this shelf on Move units to put units on it.
              </EmptyState>
            ) : (
              <div
                className="table-frame table-stack"
                role="region"
                aria-label="Units on this shelf"
                tabIndex={0}
              >
                <table className="data-table">
                  <caption className="visually-hidden">Units on this shelf</caption>
                  <thead>
                    <tr>
                      <th scope="col">Unit ID</th>
                      <th scope="col">Project</th>
                      <th scope="col">Test holes · samples</th>
                      <th scope="col">Here since</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const arrived = arrivals.get(item.id);
                      return (
                        <tr key={item.id}>
                          <td data-label="Unit ID">
                            <Link
                              className="unit-link"
                              to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
                            >
                              {item.readableId}
                            </Link>
                          </td>
                          <td data-label="Project" className="mono">
                            {item.project.projectNumber}
                          </td>
                          <td data-label="Test holes · samples">
                            <UnitContentsLine unit={item} />
                          </td>
                          <td data-label="Here since" className="mono nowrap">
                            {arrived
                              ? dateFormat.format(new Date(arrived))
                              : `Received ${item.receivedDate}`}
                          </td>
                          <td data-label="Status">
                            {isDue(item) && item.status === 'in_stock' ? (
                              <StatusBadge tone="waiting">Retention due</StatusBadge>
                            ) : (
                              <StorageUnitStatusBadge status={item.status} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {total > items.length ? (
              <p className="field-hint">
                Showing {items.length} of {total}.{' '}
                <Link to={`/sample-storage?locationId=${encodeURIComponent(location.id)}`}>
                  See them all in Inventory
                </Link>
              </p>
            ) : null}
          </section>

          <section className="unit-section" aria-labelledby="shelf-activity-heading">
            <SectionHead
              id="shelf-activity-heading"
              title="Comings and goings"
              meta="Last 30 days"
            />
            {shelf.activity.movements.length === 0 ? (
              <EmptyState>No units came or went in the last 30 days.</EmptyState>
            ) : (
              <ol className="history" aria-label="Comings and goings">
                {shelf.activity.movements.map((move) => (
                  <li key={move.id} data-row>
                    <span className="history-when">
                      <time dateTime={move.occurredAt}>
                        {timeFormat.format(new Date(move.occurredAt))}
                      </time>
                    </span>
                    <span>
                      <strong>
                        {move.storageUnit.readableId} {move.direction === 'in' ? 'arrived' : 'left'}
                      </strong>
                      <span className="history-who">
                        {' '}
                        {formatPerson(move.actor.initials, move.actor.name)}
                        {move.mover
                          ? ` for ${formatPerson(move.mover.initials, move.mover.name)}`
                          : ''}
                        , {move.direction === 'in' ? 'from' : 'to'} {move.otherLocation.name}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div data-row>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Queues this location's label on the label printer (the server decides print or reprint). */
function PrintShelfLabel({ locationId }: { locationId: string }) {
  const [job, setJob] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function print() {
    setBusy(true);
    setError(null);
    const result = await printLocationLabel(locationId, {});
    setBusy(false);
    if (result.ok) setJob(result.data);
    else setError(result.message);
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void print()}>
        Print shelf label
      </button>
      {job ? <PrintJobStatus job={job} /> : null}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
