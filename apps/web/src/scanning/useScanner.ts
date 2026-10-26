import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { cleanScannedValue, DuplicateScanFilter, SCAN_DUPLICATE_WINDOW_MS } from './scan-core';

export interface UseScannerOptions {
  /** A new, non-duplicate scan (trimmed). */
  onScan: (value: string) => void;
  /** The same payload again inside the duplicate window: no lookup happens. */
  onDuplicate?: (value: string) => void;
  duplicateWindowMs?: number;
  /** Clock for tests. */
  now?: () => number;
}

export interface Scanner {
  value: string;
  /** True when focus has left the scan panel, so scans would go nowhere (T16 AC7). */
  paused: boolean;
  /** Puts focus back in the scan field. */
  resume: () => void;
  /** Forget the last payload so the same code can be scanned again at once (Retry). */
  resetDuplicates: () => void;
  inputProps: {
    ref: (element: HTMLInputElement | null) => void;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    onFocus: () => void;
  };
  containerProps: {
    onBlur: (event: FocusEvent<HTMLDivElement>) => void;
  };
}

/**
 * Keyboard-wedge scan capture (MM-T16). The DS3678-XR cradle types the symbol's data and then
 * Enter into whichever field has focus; this hook owns that field. On Enter it trims the value,
 * drops duplicates inside the window, clears the field and keeps focus there for the next scan.
 * Focus leaving the scan panel marks the scanner paused so the screen can say so.
 */
export function useScanner(options: UseScannerOptions): Scanner {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInput = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
  }, []);
  const [value, setValue] = useState('');
  const [paused, setPaused] = useState(false);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const filterRef = useRef<DuplicateScanFilter | null>(null);
  const filter = () => {
    filterRef.current ??= new DuplicateScanFilter(
      optionsRef.current.duplicateWindowMs ?? SCAN_DUPLICATE_WINDOW_MS,
      () => (optionsRef.current.now ?? Date.now)(),
    );
    return filterRef.current;
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const resume = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const resetDuplicates = useCallback(() => filterRef.current?.reset(), []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const scanned = cleanScannedValue(event.currentTarget.value);
    setValue('');
    if (scanned === '') return;
    if (filter().accept(scanned)) {
      optionsRef.current.onScan(scanned);
    } else {
      optionsRef.current.onDuplicate?.(scanned);
    }
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setPaused(true);
  }

  return {
    value,
    paused,
    resume,
    resetDuplicates,
    inputProps: {
      ref: setInput,
      value,
      onChange: (event) => setValue(event.target.value),
      onKeyDown,
      onFocus: () => setPaused(false),
    },
    containerProps: { onBlur },
  };
}
