import type { DisposalScanResult } from '@materialmule/shared';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../components/ui';
import { useOnline } from '../lib/online';
import { useMe } from '../session/context';
import { scanForDisposal } from './api';

interface Row {
  key: string;
  code: string;
  result: DisposalScanResult | { result: 'error'; message: string };
}

/**
 * Disposal scan (MM-T30): a distinct mode, not Move. Online only: offline the input is disabled
 * and nothing is saved or queued (D28). Each scan is checked by the server at that moment (an
 * approval, then holds, retention and programs again) and shows Disposed / Not approved / Blocked.
 * Personal accounts only; a LAB station is told to sign in personally.
 */
export function DisposalScanPage() {
  const me = useMe();
  const online = useOnline();
  const [code, setCode] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const allowed = me.permissions.includes('storage_unit.dispose_scan');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const scanned = code.trim();
    if (!scanned || !online) return;
    setBusy(true);
    setCode('');
    const result = await scanForDisposal(scanned, crypto.randomUUID());
    setRows((list) => [{ key: crypto.randomUUID(), code: scanned, result }, ...list]);
    setBusy(false);
    input.current?.focus();
  }

  return (
    <div className="disposal-scan">
      <div className="disposal-scan-banner" role="note">
        <h1>Disposal scan</h1>
        <p>
          Scanning a unit here records that it has physically left for disposal. This is not Move
          mode.
        </p>
      </div>
      <p className="back-link">
        <Link to="/disposal-retention">← Disposal & Retention</Link>
      </p>
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
      <form className="disposal-scan-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="disposal-scan-input">Scan or type a storage unit ID</label>
        <input
          id="disposal-scan-input"
          ref={input}
          value={code}
          autoComplete="off"
          autoFocus
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
      </form>
      <ul className="disposal-scan-results" aria-label="Scan results">
        {rows.map((row) => (
          <li key={row.key}>
            <ResultBadge result={row.result.result} /> {row.code}: {row.result.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  switch (result) {
    case 'disposed':
      return <StatusBadge tone="success">Disposed</StatusBadge>;
    case 'not_approved':
      return <StatusBadge tone="danger">Not approved</StatusBadge>;
    case 'blocked':
      return <StatusBadge tone="danger">Blocked</StatusBadge>;
    case 'not_found':
      return <StatusBadge tone="danger">Not found</StatusBadge>;
    default:
      return <StatusBadge tone="warning">Not recorded</StatusBadge>;
  }
}
