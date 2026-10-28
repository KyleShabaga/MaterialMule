import {
  formatStorageUnitHoleSummary,
  parseScanPayload,
  storageUnitTypeLabel,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/ui';
import { fetchStorageUnit } from '../inventory/api';
import { StorageUnitStatusBadge } from '../inventory/StorageUnitStatusBadge';
import '../inventory/inventory.css';
import { CameraScanButton } from './CameraScanButton';
import { playScanTone, useScanSound } from './feedback';
import { displayScannedValue } from './scan-core';
import { ScanInput, type ScanStatusView } from './ScanInput';
import { useScanLookup, type ScanLookupState } from './useScanLookup';

/**
 * Sample Storage → Scan (MM-T16 lookup mode). Each scan looks the label up and shows that storage
 * unit here; the next scan replaces it. Scanning only reads: it never moves or disposes anything.
 */
export function ScanPage() {
  const sound = useScanSound();
  const lookup = useScanLookup((_code, result) => {
    if (sound.on) playScanTone(result.kind === 'found' ? 'success' : 'failure');
  });
  const { state } = lookup;
  const found = state.kind === 'done' && state.result.kind === 'found' ? state.result.unit : null;

  return (
    <>
      <p className="back-link">
        <Link to="/sample-storage">← Back to Sample Storage</Link>
      </p>
      <PageHeader title="Scan labels" />
      <p className="scan-intro">
        Pull the scanner&apos;s trigger on a storage unit label (Code 128 or QR). Scanning only
        opens the record; it never moves or disposes anything. On a phone, use{' '}
        <strong>Scan with camera</strong>.
      </p>
      <CameraScanButton />
      <ScanInput
        scanner={lookup.scanner}
        label="Scan a storage unit label"
        status={statusView(state, lookup.notice)}
        lastScanned={lookup.lastScanned}
        sound={sound}
        actions={
          state.kind === 'done' && state.result.kind === 'unavailable' ? (
            <button type="button" onClick={lookup.retry}>
              Retry
            </button>
          ) : state.kind === 'done' && parseScanPayload(state.code).type === 'location' ? (
            <Link className="button" to="/sample-storage/move">
              Move units
            </Link>
          ) : null
        }
      />
      {found ? <ScannedUnit key={found.id} readableId={found.readableId} /> : null}
    </>
  );
}

function statusView(state: ScanLookupState, notice: string | null): ScanStatusView {
  const detail = notice ?? undefined;
  switch (state.kind) {
    case 'ready':
      return { tone: 'ready', message: 'Ready to scan', detail };
    case 'looking':
      return { tone: 'busy', message: `Looking up ${displayScannedValue(state.code)}…`, detail };
    case 'done': {
      const code = displayScannedValue(state.code);
      switch (state.result.kind) {
        case 'found':
          return { tone: 'success', message: `Found ${state.result.unit.readableId}`, detail };
        case 'not_found':
          // A location label (MM-T37) is not a storage unit; lookup never moves anything (MM-T28).
          return parseScanPayload(state.code).type === 'location'
            ? {
                tone: 'warning',
                message: `${code} is a location label`,
                detail:
                  detail ?? 'Lookup only opens storage units. To move units there, use Move units.',
              }
            : { tone: 'error', message: `No storage unit found for ${code}`, detail };
        case 'unavailable':
          return { tone: 'error', message: `${code}: ${state.result.message}`, detail };
        case 'error':
          return { tone: 'error', message: `${code}: ${state.result.message}`, detail };
      }
    }
  }
}

/** The scanned unit's key facts, with a link to the full record. */
function ScannedUnit({ readableId }: { readableId: string }) {
  const [detail, setDetail] = useState<StorageUnitDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchStorageUnit(readableId).then((response) => {
      if (!cancelled && response.ok) setDetail(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [readableId]);

  return (
    <section className="card scanned-unit" aria-labelledby="scanned-unit-heading">
      <h2 id="scanned-unit-heading">{readableId}</h2>
      {detail ? (
        <dl className="scanned-unit-facts">
          <dt>Type</dt>
          <dd>{storageUnitTypeLabel(detail.unitType)}</dd>
          <dt>Status</dt>
          <dd>
            <StorageUnitStatusBadge status={detail.status} />
          </dd>
          <dt>Project</dt>
          <dd>
            {detail.project.projectNumber} · {detail.project.name}
          </dd>
          <dt>Saved location</dt>
          <dd>{detail.location.name}</dd>
          <dt>Test holes</dt>
          <dd>
            {detail.holes
              .map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`)
              .join(' · ')}
          </dd>
        </dl>
      ) : (
        <p aria-busy="true">Loading…</p>
      )}
      <Link
        className="button"
        to={`/sample-storage/${encodeURIComponent(readableId)}`}
        state={{ from: '' }}
      >
        Open full record
      </Link>
    </section>
  );
}
