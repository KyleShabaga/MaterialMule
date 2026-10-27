// Scan input rules shared by the handheld scanner (MM-T16) and, later, the phone camera (T17).
// No timing heuristics: a scan is whatever the focused field holds when the scanner's Enter
// suffix arrives. Validation and normalisation stay on the server (T12 lookup).

/** The same payload again within this window is ignored with "Already scanned" (T16 AC4). */
export const SCAN_DUPLICATE_WINDOW_MS = 2000;

/** Longest scanned value shown on screen; longer ones are cut with an ellipsis. */
const DISPLAY_MAX = 60;

/** Trims surrounding whitespace and drops control characters a scanner may send. */
export function cleanScannedValue(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** A scanned value made safe and short enough to show in a sentence. */
export function displayScannedValue(value: string): string {
  return value.length > DISPLAY_MAX ? `${value.slice(0, DISPLAY_MAX)}…` : value;
}

/**
 * Remembers when each payload was last accepted. `accept` returns false (a duplicate) when the
 * same payload was accepted less than `windowMs` ago; a different payload is always accepted.
 */
export class DuplicateScanFilter {
  private last: { value: string; at: number } | null = null;

  constructor(
    private readonly windowMs = SCAN_DUPLICATE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  accept(value: string): boolean {
    const at = this.now();
    if (this.last && this.last.value === value && at - this.last.at < this.windowMs) {
      return false;
    }
    this.last = { value, at };
    return true;
  }

  /** Forget the last payload, e.g. when the user presses Retry. */
  reset(): void {
    this.last = null;
  }
}
