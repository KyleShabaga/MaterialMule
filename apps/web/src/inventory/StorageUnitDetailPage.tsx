import {
  formatStorageUnitHoleSummary,
  storageUnitHistoryActionLabel,
  storageUnitTypeLabel,
  type StorageUnitDetail,
  type StorageUnitHistoryEvent,
  type StorageUnitHistoryPage,
} from '@trapezoid/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { StorageUnitLabelsSection } from '../printing/StorageUnitLabelsSection';
import { fetchStorageUnit, fetchStorageUnitHistory } from './api';
import type { InventoryLinkState } from './InventoryPage';
import './inventory.css';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';

type Loaded<T> =
  | { key: string; ok: true; data: T }
  | { key: string; ok: false; notFound: boolean; message: string };

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatTime(iso: string) {
  return <time dateTime={iso}>{timeFormat.format(new Date(iso))}</time>;
}

function person(initials: string | null, name: string | null): string {
  if (initials && name && initials !== name) return `${initials} — ${name}`;
  return initials ?? name ?? 'Unknown';
}

/**
 * Storage unit detail (TRP-T12): project and client, SAMPLE#/DEPTH summaries, receipt, saved
 * location, history and labels. Read-only: corrections (T13), moves (T28) and holds (T29) arrive
 * with their cards.
 */
export function StorageUnitDetailPage() {
  const { readableId = '' } = useParams();
  const location = useLocation();
  const from = (location.state as InventoryLinkState | null)?.from ?? '';
  const [result, setResult] = useState<Loaded<StorageUnitDetail> | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnit(readableId).then((response) => {
      if (cancelled) return;
      setResult(
        response.ok
          ? { key: readableId, ok: true, data: response.data }
          : { key: readableId, ...response },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [readableId, reloads]);

  const back = (
    <p className="back-link">
      <Link to={`/sample-storage${from}`}>← Back to Sample Storage</Link>
    </p>
  );

  if (!result || result.key !== readableId) {
    return (
      <>
        {back}
        <PageHeader title={readableId} />
        <p aria-busy="true">Loading…</p>
      </>
    );
  }
  if (!result.ok) {
    return (
      <>
        {back}
        <PageHeader title={readableId} />
        {result.notFound ? (
          <EmptyState>No storage unit found with ID {readableId}.</EmptyState>
        ) : (
          <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
        )}
      </>
    );
  }

  const unit = result.data;
  return (
    <>
      {back}
      <div className="unit-header">
        <h1 className="unit-id">{unit.readableId}</h1>
        <p className="unit-meta">
          <span>{storageUnitTypeLabel(unit.unitType)}</span>
          <StorageUnitStatusBadge status={unit.status} />
          <span>
            Saved location: <strong>{unit.location.name}</strong>
          </span>
        </p>
      </div>

      <nav className="sub-nav" aria-label="Storage unit sections">
        <a href="#summaries">Summaries</a>
        <a href="#receipt">Receipt</a>
        <a href="#location">Location</a>
        <a href="#history">History</a>
        <a href="#label-preview">Preview label</a>
        <a href="#labels">Labels</a>
      </nav>

      <section className="card" id="summaries" aria-labelledby="summaries-heading">
        <h2 id="summaries-heading">Summaries</h2>
        <dl className="details">
          <Detail term="Project">
            {unit.project.projectNumber} — {unit.project.name}
          </Detail>
          <Detail term="Client">{unit.project.client}</Detail>
        </dl>
        <ul className="hole-summaries" aria-label="Test hole summaries">
          {unit.holes.map((hole) => (
            <li key={hole.testHoleId}>
              <strong>{hole.testHoleName}</strong>: {formatStorageUnitHoleSummary(hole)}
              {hole.note ? <span className="field-hint"> Note: {hole.note}</span> : null}
            </li>
          ))}
        </ul>
        <dl className="details">
          <Detail term="Storage unit note">{unit.note ?? 'None'}</Detail>
        </dl>
      </section>

      <section className="card" id="receipt" aria-labelledby="receipt-heading">
        <h2 id="receipt-heading">Receipt</h2>
        <dl className="details">
          <Detail term="Received date">{unit.receipt.receivedDate}</Detail>
          <Detail term="Received by">
            {person(unit.receipt.receiver.initials, unit.receipt.receiver.name)}
          </Detail>
          <Detail term="Account">
            {person(unit.receipt.account.initials, unit.receipt.account.name)}
          </Detail>
          <Detail term="Confirmed">{formatTime(unit.receipt.confirmedAt)}</Detail>
          <Detail term="Storage units in receipt">{unit.receipt.quantity}</Detail>
          <Detail term="Description">{unit.receipt.description ?? 'None'}</Detail>
        </dl>
      </section>

      <section className="card" id="location" aria-labelledby="location-heading">
        <h2 id="location-heading">Location and retention</h2>
        <dl className="details">
          <Detail term="Saved location">
            {unit.location.name} ({unit.location.code})
          </Detail>
          <Detail term="Pending move">None. Queued moves arrive with TRP-T28.</Detail>
          <Detail term="Retain until and holds">Arrive with TRP-T29.</Detail>
        </dl>
      </section>

      <HistorySection storageUnitId={unit.id} />

      <section className="card" id="label-preview" aria-labelledby="label-preview-heading">
        <h2 id="label-preview-heading">Preview label</h2>
        <LabelPreviewPanel
          storageUnit={unit.readableId}
          receipt={{ id: unit.receipt.id, quantity: unit.receipt.quantity }}
        />
      </section>

      <StorageUnitLabelsSection readableId={unit.readableId} />
    </>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function changes(event: StorageUnitHistoryEvent): string[] {
  if (!event.before || !event.after) return [];
  return Object.keys(event.after)
    .filter((key) => key in event.before!)
    .map((key) => `${key}: ${String(event.before![key])} → ${String(event.after![key])}`);
}

/** Audit history, newest first, 20 per page; never loaded in full. */
function HistorySection({ storageUnitId }: { storageUnitId: string }) {
  const [page, setPage] = useState(1);
  const key = `${storageUnitId}:${page}`;
  const [result, setResult] = useState<Loaded<StorageUnitHistoryPage> | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnitHistory(storageUnitId, page).then((response) => {
      if (cancelled) return;
      setResult(response.ok ? { key, ok: true, data: response.data } : { key, ...response });
    });
    return () => {
      cancelled = true;
    };
  }, [storageUnitId, page, key, reloads]);

  let body: ReactNode;
  if (!result || result.key !== key) {
    body = <p aria-busy="true">Loading…</p>;
  } else if (!result.ok) {
    body = <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />;
  } else if (result.data.items.length === 0) {
    body = <EmptyState>No history yet.</EmptyState>;
  } else {
    const totalPages = Math.max(1, Math.ceil(result.data.total / result.data.pageSize));
    body = (
      <>
        <ol className="history" aria-label="History events">
          {result.data.items.map((event) => (
            <li key={event.id}>
              <span className="history-when">{formatTime(event.occurredAt)}</span>{' '}
              <strong>{storageUnitHistoryActionLabel(event.action)}</strong>{' '}
              <span>
                by {person(event.actor.initials, event.actor.name)}
                {event.receiver
                  ? ` for ${person(event.receiver.initials, event.receiver.name)}`
                  : ''}
              </span>
              {event.reason ? <span className="field-hint"> Reason: {event.reason}</span> : null}
              {changes(event).map((change) => (
                <span key={change} className="field-hint">
                  {' '}
                  {change}
                </span>
              ))}
            </li>
          ))}
        </ol>
        {totalPages > 1 ? (
          <nav className="pager" aria-label="History pages">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Newer
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Older
            </button>
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <section className="card" id="history" aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      {body}
    </section>
  );
}
