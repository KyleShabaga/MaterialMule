import { useRef, useState } from 'react';
import { scanLookup, type ScanLookupResult } from './api';
import { displayScannedValue } from './scan-core';
import { useScanner, type Scanner } from './useScanner';

export type ScanLookupState =
  | { kind: 'ready' }
  | { kind: 'looking'; code: string }
  | { kind: 'done'; code: string; result: ScanLookupResult };

export interface ScanLookup {
  scanner: Scanner;
  state: ScanLookupState;
  /** The last value read from the scanner, shortened for display. */
  lastScanned: string | null;
  /** "Already scanned" after a duplicate inside the window, until the next scan. */
  notice: string | null;
  /** Looks the current value up again (after "server unavailable"). */
  retry: () => void;
}

/**
 * A scanner whose every scan is looked up with T12's lookup (TRP-T16). Only the newest scan's
 * answer is kept; a duplicate inside the window makes no request. Lookups are never queued: if
 * one fails the value stays on screen with Retry.
 */
export function useScanLookup(
  onResult?: (code: string, result: ScanLookupResult) => void,
): ScanLookup {
  const [state, setState] = useState<ScanLookupState>({ kind: 'ready' });
  const [lastScanned, setLastScanned] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);

  async function run(code: string) {
    const current = ++sequence.current;
    setState({ kind: 'looking', code });
    const result = await scanLookup(code);
    if (current !== sequence.current) return;
    setState({ kind: 'done', code, result });
    onResult?.(code, result);
  }

  const scanner = useScanner({
    onScan: (code) => {
      setLastScanned(displayScannedValue(code));
      setNotice(null);
      void run(code);
    },
    onDuplicate: (code) => {
      setLastScanned(displayScannedValue(code));
      setNotice('Already scanned');
    },
  });

  function retry() {
    if (state.kind !== 'done') return;
    setNotice(null);
    scanner.resetDuplicates();
    scanner.resume();
    void run(state.code);
  }

  return { scanner, state, lastScanned, notice, retry };
}
