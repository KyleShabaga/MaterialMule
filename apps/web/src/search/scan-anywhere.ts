import { useEffect, useRef } from 'react';
import { cleanScannedValue, DuplicateScanFilter } from '../scanning/scan-core';

// Scan from anywhere (DESIGN.md › UX changes 1, STRATA-14). A USB wedge scanner types a label's
// characters very fast and ends with Enter. When that arrives while nothing editable has focus and
// no dialog owns focus, the read is a search: the shell opens the unit or shelf, else the results.
// Focused scan fields (Move, Disposal scan, Receive, the camera dialog, the command menu) keep
// their own handling (useScanner): an editable or dialog target is never buffered here, and a page
// with its own scan field (useOwnScans) keeps its reads even while that field is unfocused.

/** Longest pause between two scanner keystrokes; people type far slower than this. */
export const WEDGE_MAX_GAP_MS = 50;
/** Fewer characters than this is a keyboard shortcut or a stray key, never a label. */
export const WEDGE_MIN_LENGTH = 4;

/** Whether focus on `target` means keystrokes belong to that field or dialog, not to us. */
export function isEditableOrDialogTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!target.closest('[role="dialog"], [role="alertdialog"], dialog, [role="menu"]');
}

/** Pages mounted right now that have their own scan field (useScanner). */
let pageScanners = 0;

/**
 * Marks the calling page as owning wedge reads while it is mounted (useScanner's pages: Scan,
 * Move, Verify labels). Focused or not, its reads are its own: with the field unfocused the page
 * asks the person to resume scanning (MM-T16 AC7), so scan-anywhere never opens a record from
 * there or navigates away from a move in progress.
 */
export function useOwnScans(): void {
  useEffect(() => {
    pageScanners += 1;
    return () => {
      pageScanners -= 1;
    };
  }, []);
}

/** Whether a modal dialog is open anywhere (Radix dialogs, native <dialog open>). */
function modalOpen(doc: Document): boolean {
  return !!doc.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]',
  );
}

export interface WedgeKey {
  key: string;
  at: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * Pure keystroke buffer: feed it keys (outside editable targets), it answers with a scanned value
 * when a fast burst ends in Enter. Slow (human) typing resets the buffer, so it never fires.
 */
export class WedgeDetector {
  private buffer = '';
  private lastAt = -Infinity;

  constructor(
    private readonly maxGapMs = WEDGE_MAX_GAP_MS,
    private readonly minLength = WEDGE_MIN_LENGTH,
  ) {}

  /** True while a fast burst is under way (the last key came within the gap). */
  inBurst(at: number): boolean {
    return this.buffer.length > 0 && at - this.lastAt <= this.maxGapMs;
  }

  /** Returns the scanned value when `key` completes a scan; otherwise null. */
  feed(event: WedgeKey): string | null {
    if (event.isComposing || event.key === 'Process' || event.key === 'Dead') {
      this.reset();
      return null;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      this.reset();
      return null;
    }
    if (event.key === 'Enter') {
      const fast = event.at - this.lastAt <= this.maxGapMs;
      const value = cleanScannedValue(this.buffer);
      this.reset();
      return fast && value.length >= this.minLength ? value : null;
    }
    if (event.key.length !== 1) {
      // Shift and other modifiers come with a scanner's capitals; they don't break a burst.
      return null;
    }
    if (this.buffer.length > 0 && event.at - this.lastAt > this.maxGapMs) this.buffer = '';
    this.buffer += event.key;
    this.lastAt = event.at;
    return null;
  }

  reset(): void {
    this.buffer = '';
    this.lastAt = -Infinity;
  }
}

export interface ScanAnywhereOptions {
  onScan: (value: string) => void;
  enabled?: boolean;
  /** Clock for tests. */
  now?: () => number;
}

/**
 * Listens on the document for wedge reads with no editable target and no open dialog. Keys are
 * never swallowed except the burst's closing Enter, so normal typing, shortcuts and IME input
 * behave exactly as before. A repeat of the same label within 2 s is ignored (useScanner's rule).
 */
export function useScanAnywhere({ onScan, enabled = true, now }: ScanAnywhereOptions): void {
  const optionsRef = useRef({ onScan, now });
  useEffect(() => {
    optionsRef.current = { onScan, now };
  });

  useEffect(() => {
    if (!enabled) return;
    const detector = new WedgeDetector();
    const clock = () => (optionsRef.current.now ?? performance.now.bind(performance))();
    const duplicates = new DuplicateScanFilter(undefined, clock);
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (pageScanners > 0 || isEditableOrDialogTarget(event.target) || modalOpen(document)) {
        detector.reset();
        return;
      }
      const scanned = detector.feed({
        key: event.key,
        at: clock(),
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
      });
      if (scanned === null) return;
      event.preventDefault();
      if (duplicates.accept(scanned)) optionsRef.current.onScan(scanned);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
