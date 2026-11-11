import {
  currentLocationName,
  SAMPLING_SOURCE_TYPE_LABEL,
  describeStorageUnitCorrection,
  formatCoreRuns,
  formatDepth,
  formatPerson,
  formatSampleIdentity,
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
import {
  BandedCard,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionHead,
  StatusBadge,
  UnitLabel,
} from '../components/ui';
import { FEATURES } from '../features';
import { ContextRow } from '../layout/ContextRow';
import { LocationConflictSection, PendingMoveNote } from '../moves/LocationConflictSection';
import type { MoveLinkState } from '../moves/move-link';
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
import { UnitLabPrograms } from './UnitLabPrograms';
import { usePageTitle } from '../layout/page-title';

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
 * Storage unit detail (MM-T12) in the Field Ledger layout: the label block leads, then where the
 * unit is, its lab program progress and its history, newest first. A disposed unit is a closed
 * record: its label is drawn grey, it says so, and it can't be moved or relabelled. Personal
 * accounts can still correct its received date and note (BUG-014); the server refuses the rest.
 *
 * MM-T79 (owner decision 2026-10-30): links on this page answer hover with darker text only, no
 * underline, like Settings. The `unit-page` wrapper scopes that.
 */
export function StorageUnitDetailPage() {
  return (
    <div className="unit-page">
      <StorageUnitDetail />
    </div>
  );
}

function StorageUnitDetail() {
  const { readableId = '' } = useParams();
  usePageTitle(readableId);
  const location = useLocation();
  const from = (location.state as InventoryLinkState | null)?.from ?? '';
  const [result, setResult] = useState<Loaded<StorageUnitDetail> | null>(null);
  const [reloads, setReloads] = useState(0);
  const { session } = useSession();
  const permissions = session.status === 'active' ? session.me.permissions : [];
  const canCorrect = permissions.includes('storage_unit.correct');
  // Confirming a conflicted unit's actual location: personal accounts only (MM-T28, D29).
  const canResolve = permissions.includes('location_conflict.resolve');
  // Removal after testing: personal accounts only, never LAB (MM-T36).
  const canRemoveTested = permissions.includes('storage_unit.tested_removal');
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

  const backLink = <Link to={`/sample-storage${from}`}>← Back to inventory</Link>;

  if (!result || result.key !== readableId) {
    return (
      <>
        <ContextRow>{backLink}</ContextRow>
        <PageHeader title={readableId} />
        <p aria-busy="true">Loading…</p>
      </>
    );
  }
  if (!result.ok) {
    return (
      <>
        <ContextRow>{backLink}</ContextRow>
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
  const disposed = unit.status === 'disposed';
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
        <ContextRow>
          <button type="button" className="link-button" onClick={closeCorrection}>
            ← Back to {unit.readableId}
          </button>
        </ContextRow>
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

  const labelLines: { hole: string; summary?: string }[] = unit.sample
    ? [{ hole: formatSampleIdentity(unit.sample) }]
    : unit.holes.map((hole) => ({
        hole: hole.testHoleName,
        summary: formatStorageUnitHoleSummary(hole),
      }));
  if (unit.coreRunCount) labelLines.push({ hole: formatCoreRuns(unit.coreRunCount) });

  return (
    <>
      <ContextRow>
        {backLink}
        <span className="unit-context-actions">
          {disposed ? null : (
            <a className="button" href="#label-preview">
              Reprint label
            </a>
          )}
          {canCorrect ? (
            <button
              type="button"
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
            <span className="field-hint">Corrections need a personal account.</span>
          )}
          {disposed ? null : (
            <Link
              className="button primary"
              to="/sample-storage/move"
              state={{ units: [unit.readableId] } satisfies MoveLinkState}
            >
              Move unit
            </Link>
          )}
        </span>
      </ContextRow>

      {disposed ? (
        <div className="unit-closed-strip" role="status">
          <StatusBadge tone="closed">Disposed</StatusBadge>
          <span>
            <strong>This record is closed.</strong> The unit was disposed of. It can’t be moved or
            relabelled, and its ID is never issued again. Its history is kept in full.
          </span>
        </div>
      ) : null}

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

      <div className="unit-layout">
        <div className="unit-side">
          <UnitLabel
            holder={storageUnitTypeLabel(unit.unitType)}
            project={unit.project.projectNumber}
            unitId={unit.readableId}
            lines={labelLines}
            closed={disposed}
            headingLevel={1}
          />

          <section id="summaries" className="unit-facts" aria-labelledby="summaries-heading">
            <h2 id="summaries-heading" className="visually-hidden">
              Summaries
            </h2>
            <dl className="fact-list">
              <Detail term="Project">
                <span className="project-number">{unit.project.projectNumber}</span> ·{' '}
                {unit.project.name}
              </Detail>
              <Detail term="Client">{unit.project.client}</Detail>
              <Detail term="Received">
                <span className="nowrap mono">{unit.receivedDate}</span>
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
              {unit.coreRunCount ? (
                <Detail term="Core runs">{formatCoreRuns(unit.coreRunCount)}</Detail>
              ) : null}
              <Detail term="Storage unit note">{unit.note ?? 'None'}</Detail>
            </dl>
          </section>

          <BandedCard id="receipt" title="Receipt">
            <dl className="fact-list">
              <Detail term="Received date">
                <span className="nowrap mono">{unit.receipt.receivedDate}</span>
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
        </div>

        <div className="unit-main">
          <section id="location" className="unit-section" aria-labelledby="location-heading">
            <SectionHead
              id="location-heading"
              title="Where it is"
              meta={
                <span className="unit-status-tags">
                  <StorageUnitStatusBadge
                    status={unit.status}
                    testedRemovalReason={unit.testing?.removal?.reason ?? null}
                  />
                  {unit.locationConflict ? (
                    <StatusBadge tone="danger">Location conflict</StatusBadge>
                  ) : null}
                </span>
              }
            />
            {disposed ? (
              // MISC-12: a disposed unit has no current location; its moves stay in History.
              <div className="where-cells where-cells-closed">
                <p className="where-closed">{currentLocationName(unit)}</p>
              </div>
            ) : (
              <div className="where-cells">
                <div className="where-cell where-cell-current">
                  <span className="field-label">Location</span>
                  <Link
                    className="where-value"
                    to={shelfPath(unit.location.code)}
                    aria-label={`${unit.location.name} (${unit.location.code})`}
                  >
                    {unit.location.name}
                  </Link>
                </div>
                <div className="where-cell">
                  <span className="field-label">Code</span>
                  <span className="where-value mono">{unit.location.code}</span>
                </div>
              </div>
            )}
            <dl className="fact-list">
              <Detail term="Pending move">
                <PendingMoveNote unitId={unit.id} />
              </Detail>
              {retentionExempt ? (
                // MM-T36: the post-testing route ignores retention, extensions and holds.
                <Detail term="Retention">{testedRetentionNote(unit.testing!.reason!)}</Detail>
              ) : (
                <Detail term="Retain until (minimum)">
                  <span className="nowrap mono">{unit.minimumRetainUntil}</span>
                  <span className="field-hint"> Received date + 1 year.</span>
                </Detail>
              )}
            </dl>
          </section>

          {FEATURES.labTesting ? <UnitLabPrograms unitId={unit.id} /> : null}

          <HistorySection storageUnitId={unit.id} refresh={historyVersion} disposed={disposed} />

          <UnitRetentionCard
            key={`retention-${unit.version}`}
            unitId={unit.id}
            unitType={unit.unitType}
            disposed={disposed}
          />

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

      <StorageUnitLabelsSection readableId={unit.readableId} disposed={disposed} />
    </>
  );
}

/** The shelf page a location's label lands on. */
function shelfPath(code: string) {
  return `/sample-storage/locations/${encodeURIComponent(code)}`;
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div data-row>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Test identities' actions carry the same TEST badge as the header (MTR-3, MM-T33). */
function ActorTestBadge({ accountType }: { accountType: string | null }) {
  if (accountType !== 'test') return null;
  return (
    <>
      {' '}
      <span className="badge" title="Done by a test account">
        TEST
      </span>
    </>
  );
}

/** One audit value as text: a location (or any `{name, code}`) reads "name (code)" (MTR-64). */
function formatHistoryValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.code === 'string') {
    return `${record.name} (${record.code})`;
  }
  return JSON.stringify(value);
}

function changes(event: StorageUnitHistoryEvent): string[] {
  // A hold's or extension's label says it all; its audit values are bookkeeping (MTR-59).
  if (!event.before || !event.after || event.action.startsWith('retention.')) return [];
  return Object.keys(event.after)
    .filter((key) => key in event.before!)
    .map(
      (key) =>
        `${key}: ${formatHistoryValue(event.before![key])} → ${formatHistoryValue(event.after![key])}`,
    );
}

/** Audit history, newest first, 20 per page; never loaded in full. */
function HistorySection({
  storageUnitId,
  refresh,
  disposed,
}: {
  storageUnitId: string;
  refresh: number;
  disposed: boolean;
}) {
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
              data-row
              className={
                event.action === 'storage_unit.corrected' ? 'history-event-corrected' : undefined
              }
            >
              <span className="history-when">{formatTime(event.occurredAt)}</span>{' '}
              <span>
                <strong>{storageUnitHistoryActionLabel(event.action, event.after)}</strong>{' '}
                {event.action === 'storage_unit.corrected' ? (
                  // e.g. "KCS changed received date 2026-10-23 → 2026-10-21 · Reason: wrong date on tag"
                  <span className="history-who">
                    {event.actor.initials ?? event.actor.name ?? 'Unknown'}
                    <ActorTestBadge accountType={event.actor.accountType} /> changed{' '}
                    {describeStorageUnitCorrection(event.before, event.after).join('; ')}
                    {event.reason ? ` · Reason: ${event.reason}` : ''}
                  </span>
                ) : (
                  <>
                    <span className="history-who">
                      by {formatPerson(event.actor.initials, event.actor.name)}
                      <ActorTestBadge accountType={event.actor.accountType} />
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
            <span className="mono">
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
    <section id="history" className="unit-section" aria-labelledby="history-heading">
      <SectionHead
        id="history-heading"
        title="History"
        meta={disposed ? 'Kept in full' : 'Every change, newest first'}
      />
      {body}
    </section>
  );
}
