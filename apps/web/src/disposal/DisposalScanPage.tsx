import type { DisposalReady, DisposalScanResult } from '@materialmule/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CountedCells,
  PageHeader,
  SectionHead,
  SidePanel,
  StatusBadge,
  type CountedCellState,
} from '../components/ui';
import { ContextRow } from '../layout/ContextRow';
import { useOnline } from '../lib/online';
import { useMe } from '../session/context';
import { fetchReady, scanForDisposal } from './api';
import './disposal.css';

interface Row {
  key: string;
  code: string;
  at: string;
  result: DisposalScanResult | { result: 'error'; message: string };
}

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Disposal scan (MM-T30): a distinct mode, not Move. Online only: offline the input is disabled
 * and nothing is saved or queued (D28). Each scan is checked by the server at that moment (an
 * approval, then holds, retention and programs again) and shows Disposed / Not approved / Blocked.
 * Personal accounts only; a LAB station is told to sign in personally.
 *
 * Field Ledger: results newest first on the left; at the side, the approved units waiting for
 * this scan (the disposal list) with which of them have been scanned here. Only scanned units are
 * disposed of; the others stay approved for next time.
 */
export function DisposalScanPage() {
  const me = useMe();
  const online = useOnline();
  const [code, setCode] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const allowed = me.permissions.includes('storage_unit.dispose_scan');
  const [ready, setReady] = useState<DisposalReady | null>(null);

  useEffect(() => {
    let active = true;
    void fetchReady().then((next) => {
      if (active) setReady(next);
    });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const scanned = code.trim();
    if (!scanned || !online) return;
    setBusy(true);
    setCode('');
    const result = await scanForDisposal(scanned, crypto.randomUUID());
    setRows((list) => [
      { key: crypto.randomUUID(), code: scanned, at: new Date().toISOString(), result },
      ...list,
    ]);
    setBusy(false);
    input.current?.focus();
  }

  const disposedHere = new Set(
    rows.filter((row) => row.result.result === 'disposed').map((row) => row.code.toUpperCase()),
  );
  const approved = ready?.units.filter((unit) => unit.stage === 'approved') ?? [];
  const scannedCount = approved.filter((unit) => disposedHere.has(unit.readableId)).length;
  const cells: CountedCellState[] = approved.map((unit) =>
    disposedHere.has(unit.readableId) ? 'done' : 'empty',
  );

  return (
    <div className="disposal-scan">
      <ContextRow>
        <Link to="/disposal-retention">← Back to retention</Link>
      </ContextRow>
      <div className="retention-title">
        <PageHeader title="Disposal scan" />
        <span className="section-meta">Scan each unit as it leaves the shelf</span>
      </div>
      <div className="disposal-scan-banner" role="note">
        <p>
          Scanning a unit here records that it has physically left for disposal. This is not Move
          mode.
        </p>
      </div>
      {!allowed ? (
        <p className="notice" role="alert">
          Disposal scans need a personal sign-in. A shared LAB station can’t record disposal.
        </p>
      ) : !online ? (
        <p className="notice" role="alert">
          Disposal scanning needs a connection to Material Mule. It is switched off while offline,
          and nothing is saved or queued.
        </p>
      ) : null}

      <div className="disposal-scan-layout">
        <section className="disposal-scan-main" aria-labelledby="disposal-scan-results-heading">
          <form className="disposal-scan-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="disposal-scan-input">Scan or type a storage unit ID</label>
            <div className="inline-input">
              <input
                id="disposal-scan-input"
                ref={input}
                value={code}
                className="mono"
                autoComplete="off"
                autoFocus
                placeholder="Waiting for a scan…"
                disabled={!online || !allowed || busy}
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                type="submit"
                className="danger"
                disabled={!online || !allowed || busy || !code.trim()}
              >
                Dispose
              </button>
            </div>
          </form>
          <SectionHead
            id="disposal-scan-results-heading"
            title="Scan results"
            meta={`${rows.length} ${rows.length === 1 ? 'scan' : 'scans'} · newest first`}
          />
          {rows.length === 0 ? <p className="empty-state">Nothing scanned yet.</p> : null}
          <ul className="disposal-scan-results" aria-label="Scan results">
            {rows.map((row) => (
              <li key={row.key} data-row>
                <ResultBadge result={row.result.result} />{' '}
                <span className="disposal-scan-text">
                  <span className="mono">{row.code}</span>: {row.result.message}
                </span>
                <time className="history-when" dateTime={row.at}>
                  {timeFormat.format(new Date(row.at))}
                </time>
              </li>
            ))}
          </ul>
        </section>

        <SidePanel
          className="disposal-scan-side"
          title="Disposal list"
          aside={
            <span className="section-meta">
              {scannedCount} of {approved.length} scanned
            </span>
          }
        >
          {ready === null ? (
            <p className="field-hint">The approved units couldn’t be loaded.</p>
          ) : approved.length === 0 ? (
            <p className="field-hint">
              No units are approved and waiting. Approve them on{' '}
              <Link to="/disposal-retention">Retention</Link> first.
            </p>
          ) : (
            <>
              <CountedCells
                cells={cells}
                label={`${scannedCount} of ${approved.length} approved units scanned`}
              />
              <ul className="disposal-list-items" aria-label="Approved units">
                {approved.map((unit) => (
                  <li key={unit.storageUnitId} data-row>
                    <span className="mono">{unit.readableId}</span>
                    {disposedHere.has(unit.readableId) ? (
                      <StatusBadge tone="closed">Scanned</StatusBadge>
                    ) : (
                      <span className="field-hint">Not yet · {unit.location.name}</span>
                    )}
                  </li>
                ))}
              </ul>
              {ready.total > ready.units.length ? (
                <p className="field-hint">
                  Showing the first {ready.units.length} ready units of {ready.total}.
                </p>
              ) : null}
            </>
          )}
          <p className="field-hint">
            Only scanned units are disposed of. The ones not scanned stay approved for next time.
          </p>
        </SidePanel>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  switch (result) {
    case 'disposed':
      return <StatusBadge tone="storage">Disposed</StatusBadge>;
    case 'not_approved':
      return <StatusBadge tone="danger">Not approved</StatusBadge>;
    case 'blocked':
      return <StatusBadge tone="danger">Blocked</StatusBadge>;
    case 'not_found':
      return <StatusBadge tone="danger">Not found</StatusBadge>;
    default:
      return <StatusBadge tone="waiting">Not recorded</StatusBadge>;
  }
}
