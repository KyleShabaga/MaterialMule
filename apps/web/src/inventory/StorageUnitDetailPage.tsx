import {
  SAMPLING_SOURCE_TYPE_LABEL,
  describeStorageUnitCorrection,
  formatDepth,
  formatPerson,
  formatStorageUnitHoleSummary,
  storageUnitHistoryActionLabel,
  samplingSourceName,
  storageUnitTypeLabel,
  testedRetentionNote,
  type StorageUnitDetail,
  type StorageUnitHistoryEvent,
  type StorageUnitHistoryPage,
} from '@materialmule/shared';
import { UnitRetentionCard } from '../retention/RetentionSections';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { BandedCard, EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui';
import { LocationConflictSection, PendingMoveNote } from '../moves/LocationConflictSection';
import { LabelPreviewPanel } from '../printing/LabelPreviewPanel';
import { StorageUnitLabelsSection } from '../printing/StorageUnitLabelsSection';
import { useSession } from '../session/context';
import { fetchStorageUnit, fetchStorageUnitHistory } from './api';
import { BulkSampleSection } from './BulkSampleSection';
import { CONFLICT_MESSAGE, CorrectionForm } from './CorrectionForm';
import type { InventoryLinkState } from './InventoryPage';
import './inventory.css';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';
import { TestedRemovalSection } from './TestedRemovalSection';

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

/**
 * Storage unit detail (MM-T12): project and client, SAMPLE#/DEPTH summaries, receipt, saved
 * location, history and labels. Personal accounts can correct details (MM-T13); moves (T28) and
 * holds (T29) arrive with their cards.
 */
export function StorageUnitDetailPage() {
  const { readableId = '' } = useParams();
  const location = useLocation();
  const from = (location.state as InventoryLinkState | null)?.from ?? '';
  const [result, setResult] = useState<Loaded<StorageUnitDetail> | null>(null);
  const [reloads, setReloads] = useState(0);
  const { session } = useSession();
  const canCorrect =
    session.status === 'active' && session.me.permissions.includes('storage_unit.correct');
  // Confirming a conflicted unit's actual location: personal accounts only (MM-T28, D29).
  const canResolve =
    session.status === 'active' && session.me.permissions.includes('location_conflict.resolve');
  // Removal after testing: personal accounts only, never LAB (MM-T36).
  const canRemoveTested =
    session.status === 'active' && session.me.permissions.includes('storage_unit.tested_removal');
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const [resolvedNotice, setResolvedNotice] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionNotice, setCorrectionNotice] = useState<string | null>(null);
  const [corrected, setCorrected] = useState(false);
  /** Message after a bulk sample correction (MM-T36). */
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  // Correct details replaces the page (canvas): focus its heading on open, the button on close.
  const correctionHeading = useRef<HTMLHeadingElement>(null);
  const correctButton = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<'form' | 'page' | null>(null);
  useEffect(() => {
    if (focusAfter === 'form') correctionHeading.current?.focus();
    if (focusAfter === 'page') correctButton.current?.focus();
  }, [focusAfter, correcting]);

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
  // Tested (exact-unit evidence) or removed after testing: retention doesn't apply (MM-T36).
  const retentionExempt = Boolean(
    unit.testing?.reason && (unit.testing.removal || unit.testing.evidence.length > 0),
  );

  function closeCorrection() {
    setCorrecting(false);
    setCorrectionNotice(null);
    setFocusAfter('page');
  }

  if (canCorrect && correcting) {
    return (
      <div className="correction-page">
        <p className="back-link">
          <button type="button" className="link-button" onClick={closeCorrection}>
            ← Back to {unit.readableId}
          </button>
        </p>
        <div>
          <h1 id="correction-heading" ref={correctionHeading} tabIndex={-1}>
            Correct details
          </h1>
          <p className="correction-unit-id">{unit.readableId}</p>
        </div>
        <CorrectionForm
          // A newer version (e.g. after a conflict) starts the form again from the latest values.
          key={unit.version}
          unit={unit}
          notice={correctionNotice}
          onSaved={(saved) => {
            setResult({ key: readableId, ok: true, data: saved });
            setCorrected(true);
            setHistoryVersion((count) => count + 1);
            closeCorrection();
          }}
          onConflict={() => {
            setCorrectionNotice(CONFLICT_MESSAGE);
            setReloads((count) => count + 1);
            setHistoryVersion((count) => count + 1);
          }}
          onCancel={closeCorrection}
        />
      </div>
    );
  }

  return (
    <>
      {back}
      <div className="unit-header">
        <div className="unit-title">
          <h1 className="unit-id">{unit.readableId}</h1>
          <p className="unit-meta">
            <span className="type-tag type-tag-accent">{storageUnitTypeLabel(unit.unitType)}</span>
            <StorageUnitStatusBadge
              status={unit.status}
              testedRemovalReason={unit.testing?.removal?.reason ?? null}
            />
            <span className="muted">{unit.location.name}</span>
            {unit.locationConflict ? (
              <StatusBadge tone="danger">Location conflict</StatusBadge>
            ) : null}
          </p>
        </div>
        <div className="unit-actions">
          {canCorrect ? (
            <button
              type="button"
              className="primary"
              ref={correctButton}
              onClick={() => {
                setCorrectionNotice(null);
                setCorrected(false);
                setCorrecting(true);
                setFocusAfter('form');
              }}
            >
              Correct details
            </button>
          ) : (
            <p className="field-hint">Corrections need a personal account.</p>
          )}
        </div>
      </div>

      {corrected ? (
        <p className="notice notice-success" role="status">
          <strong>Details corrected.</strong> Printed labels show the values at print time. Reprint
          if the label is now wrong.
        </p>
      ) : null}

      {resolvedNotice ? (
        <p className="notice notice-success" role="status">
          <strong>Location confirmed.</strong> Both moves and your confirmation are in the history.
        </p>
      ) : null}

      {unit.locationConflict ? (
        <LocationConflictSection
          key={`${unit.locationConflict.id}-${unit.locationConflict.version}`}
          conflictId={unit.locationConflict.id}
          canResolve={canResolve}
          onResolved={() => {
            setResolvedNotice(true);
            setHistoryVersion((count) => count + 1);
            setReloads((count) => count + 1);
          }}
        />
      ) : null}

      {removalNotice ? (
        <p className="notice notice-success" role="status">
          {removalNotice}
        </p>
      ) : null}

      {bulkNotice ? (
        <p className="notice notice-success" role="status">
          {bulkNotice}
        </p>
      ) : null}

      <nav className="sub-nav" aria-label="Storage unit sections">
        <a href="#summaries">Summaries</a>
        {unit.bulkGroup ? <a href="#bulk-sample">Bulk sample</a> : null}
        {unit.testing?.reason ? <a href="#testing">Testing</a> : null}
        <a href="#receipt">Receipt</a>
        <a href="#location">Location</a>
        <a href="#history">History</a>
        <a href="#label-preview">Labels</a>
      </nav>

      <div className="unit-columns">
        <div className="unit-column">
          <BandedCard id="summaries" title="Summaries">
            <dl className="details">
              <Detail term="Project">
                <span className="project-number">{unit.project.projectNumber}</span> ·{' '}
                {unit.project.name}
              </Detail>
              <Detail term="Client">{unit.project.client}</Detail>
              <Detail term="Received date">
                <span className="nowrap">{unit.receivedDate}</span>
              </Detail>
              {unit.sample ? (
                // MM-T36: where the material came from (never its storage location).
                <>
                  <Detail term="Sampling source">
                    {samplingSourceName(unit.sample.source)}{' '}
                    <span className="muted">
                      ({SAMPLING_SOURCE_TYPE_LABEL[unit.sample.source.type]})
                    </span>
                  </Detail>
                  <Detail term="Sample reference">{unit.sample.sampleReference ?? 'None'}</Detail>
                  <Detail term="Depth">
                    {formatDepth(
                      unit.sample.depthFrom,
                      unit.sample.depthTo,
                      unit.sample.depthUnit,
                    ) || 'None'}
                  </Detail>
                </>
              ) : (
                <Detail term="Test holes">
                  <ul className="hole-summaries" aria-label="Test hole summaries">
                    {unit.holes.map((hole) => (
                      <li key={hole.testHoleId}>
                        <strong>{hole.testHoleName}</strong>: {formatStorageUnitHoleSummary(hole)}
                        {hole.note ? (
                          <>
                            {' '}
                            <span className="note-tag">Note: {hole.note}</span>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Detail>
              )}
              <Detail term="Storage unit note">{unit.note ?? 'None'}</Detail>
            </dl>
          </BandedCard>

          {unit.bulkGroup ? (
            <BulkSampleSection
              // A correction elsewhere (or a conflict reload) starts the section afresh.
              key={`${unit.version}-${unit.bulkGroup.version}`}
              unit={unit}
              canCorrect={canCorrect}
              onChanged={(changed, message) => {
                setResult({ key: readableId, ok: true, data: changed });
                setBulkNotice(message);
                setHistoryVersion((count) => count + 1);
              }}
            />
          ) : null}

          {unit.testing ? (
            <TestedRemovalSection
              key={unit.version}
              unit={unit}
              testing={unit.testing}
              canRemove={canRemoveTested}
              onRemoved={(message) => {
                setRemovalNotice(message);
                setHistoryVersion((count) => count + 1);
                setReloads((count) => count + 1);
              }}
              onStale={() => setReloads((count) => count + 1)}
            />
          ) : null}

          <HistorySection storageUnitId={unit.id} refresh={historyVersion} />
        </div>

        <div className="unit-column">
          <BandedCard id="receipt" title="Receipt">
            <dl className="details">
              <Detail term="Received date">
                <span className="nowrap">{unit.receipt.receivedDate}</span>
              </Detail>
              <Detail term="Project">
                {unit.receipt.project.projectNumber} — {unit.receipt.project.name}
              </Detail>
              <Detail term="Received by">
                {formatPerson(unit.receipt.receiver.initials, unit.receipt.receiver.name)}
              </Detail>
              <Detail term="Account">
                {formatPerson(unit.receipt.account.initials, unit.receipt.account.name)}
              </Detail>
              <Detail term="Confirmed">{formatTime(unit.receipt.confirmedAt)}</Detail>
              <Detail term="Storage units in receipt">{unit.receipt.quantity}</Detail>
              <Detail term="Description">{unit.receipt.description ?? 'None'}</Detail>
            </dl>
            <p className="field-hint">As recorded at confirmation; corrections never change it.</p>
          </BandedCard>

          <BandedCard id="location" title="Location and retention">
            <dl className="details">
              <Detail term="Saved location">
                {unit.location.name} ({unit.location.code})
              </Detail>
              <Detail term="Pending move">
                <PendingMoveNote unitId={unit.id} />
              </Detail>
              {retentionExempt ? (
                // MM-T36: the post-testing route ignores retention, extensions and holds.
                <Detail term="Retention">{testedRetentionNote(unit.testing!.reason!)}</Detail>
              ) : (
                <Detail term="Retain until (minimum)">
                  <span className="nowrap">{unit.minimumRetainUntil}</span>
                </Detail>
              )}
            </dl>
            {retentionExempt ? null : <p className="field-hint">Received date + 1 year.</p>}
          </BandedCard>

          <UnitRetentionCard
            key={`retention-${unit.version}`}
            unitId={unit.id}
            unitType={unit.unitType}
            disposed={unit.status === 'disposed'}
          />
        </div>
      </div>

      {/* Groups, not regions: the "Label" region (T15) stays the only landmark named Label. */}
      <LabelPreviewPanel
        // A correction (T13) bumps the version; the label shows the corrected details.
        key={`label-preview-${unit.version}`}
        layout="dual"
        id="label-preview"
        storageUnit={unit.readableId}
        receipt={{ id: unit.receipt.id, quantity: unit.receipt.quantity }}
      />

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
function HistorySection({ storageUnitId, refresh }: { storageUnitId: string; refresh: number }) {
  const [page, setPage] = useState(1);
  const key = `${storageUnitId}:${page}:${refresh}`;
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
  }, [storageUnitId, page, key, reloads, refresh]);

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
            <li
              key={event.id}
              className={
                event.action === 'storage_unit.corrected' ? 'history-event-corrected' : undefined
              }
            >
              <span className="history-when">{formatTime(event.occurredAt)}</span>{' '}
              <span>
                <strong>{storageUnitHistoryActionLabel(event.action)}</strong>{' '}
                {event.action === 'storage_unit.corrected' ? (
                  // e.g. "KCS changed received date 2026-10-23 → 2026-10-21 · Reason: wrong date on tag"
                  <span>
                    {event.actor.initials ?? event.actor.name ?? 'Unknown'} changed{' '}
                    {describeStorageUnitCorrection(event.before, event.after).join('; ')}
                    {event.reason ? ` · Reason: ${event.reason}` : ''}
                  </span>
                ) : (
                  <>
                    <span>
                      by {formatPerson(event.actor.initials, event.actor.name)}
                      {event.receiver
                        ? ` for ${formatPerson(event.receiver.initials, event.receiver.name)}`
                        : ''}
                    </span>
                    {event.reason ? (
                      <span className="field-hint"> Reason: {event.reason}</span>
                    ) : null}
                    {changes(event).map((change) => (
                      <span key={change} className="field-hint">
                        {' '}
                        {change}
                      </span>
                    ))}
                  </>
                )}
              </span>
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
    <BandedCard id="history" title="History">
      {body}
    </BandedCard>
  );
}
