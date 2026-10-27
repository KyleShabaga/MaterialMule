import { useState } from 'react';
import type { ScanLookupResult } from './api';
import { playScanTone, useScanSound } from './feedback';
import { displayScannedValue } from './scan-core';
import { ScanInput, type ScanStatusView } from './ScanInput';
import { useScanLookup } from './useScanLookup';

/**
 * Verify labels (MM-T16, receiving Labels step): scan each freshly printed label and check it
 * belongs to one of the storage units just received. Only reads; nothing is changed.
 */
export function VerifyLabelsPanel({
  expectedIds,
  onClose,
}: {
  expectedIds: string[];
  onClose: () => void;
}) {
  const sound = useScanSound();
  const [verified, setVerified] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<ScanStatusView | null>(null);

  function judge(code: string, result: ScanLookupResult): ScanStatusView {
    const shown = displayScannedValue(code);
    switch (result.kind) {
      case 'not_found':
        return { tone: 'error', message: `No storage unit found for ${shown}` };
      case 'unavailable':
      case 'error':
        return { tone: 'error', message: `${shown}: ${result.message}` };
      case 'found': {
        const id = result.unit.readableId;
        if (!expectedIds.includes(id)) {
          const remaining = expectedIds.filter((expected) => !verified.has(expected));
          const left = remaining.length > 0 ? remaining : expectedIds;
          const expected =
            left.length === 1 ? `Expected ${left[0]}.` : `Expected one of ${left.join(', ')}.`;
          return { tone: 'warning', message: `Wrong label: scanned ${id}. ${expected}` };
        }
        if (verified.has(id)) return { tone: 'success', message: `${id} is already verified` };
        setVerified((previous) => new Set(previous).add(id));
        return { tone: 'success', message: `Label matches ${id}` };
      }
    }
  }

  const lookup = useScanLookup((code, result) => {
    const view = judge(code, result);
    setOutcome(view);
    if (sound.on) playScanTone(view.tone === 'success' ? 'success' : 'failure');
  });
  const { state } = lookup;
  const notice = lookup.notice ?? undefined;
  const status: ScanStatusView =
    state.kind === 'looking'
      ? { tone: 'busy', message: `Checking ${displayScannedValue(state.code)}…`, detail: notice }
      : state.kind === 'done' && outcome
        ? { ...outcome, detail: notice }
        : { tone: 'ready', message: 'Scan each printed label', detail: notice };

  const count = expectedIds.filter((id) => verified.has(id)).length;

  return (
    <section className="card verify-labels" aria-labelledby="verify-labels-heading">
      <h2 id="verify-labels-heading">Verify labels</h2>
      <p>
        {count} of {expectedIds.length} labels verified
      </p>
      <ScanInput
        scanner={lookup.scanner}
        label="Scan a printed label"
        status={status}
        lastScanned={lookup.lastScanned}
        sound={sound}
        actions={
          state.kind === 'done' && state.result.kind === 'unavailable' ? (
            <button type="button" onClick={lookup.retry}>
              Retry
            </button>
          ) : null
        }
      />
      <ul className="verify-list" aria-label="Expected labels">
        {expectedIds.map((id) => (
          <li key={id} className={verified.has(id) ? 'verified' : undefined}>
            <strong>{id}</strong> {verified.has(id) ? '✓ Verified' : 'Not scanned yet'}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClose}>
        Stop verifying
      </button>
    </section>
  );
}
