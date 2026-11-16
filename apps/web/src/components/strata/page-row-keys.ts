import { useEffect, useRef } from 'react';
import { WEDGE_MAX_GAP_MS } from '../../search/scan-anywhere';

// J/K from anywhere on a list page (STRATA-134). A wedge scanner types a label as fast keystrokes
// with no field focused, and labels and project numbers contain J and K (BKT-…), so a J or K only
// navigates once the scanner gap has passed with no other key, and never when it is itself part of
// a fast burst. Scan-anywhere (search/scan-anywhere.ts) then keeps every key of a read.

const ROW_KEY_BLOCKERS =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"], [role="listbox"]';

/** Pure timing rule: which J/K presses are people, not a scanner. */
export class RowKeyGate {
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly gapMs = WEDGE_MAX_GAP_MS) {}

  /**
   * Call for every keydown, before anything else handles it. Cancels a J/K still waiting (a key
   * this soon after it means a scan) and says whether this key itself came within a burst.
   */
  key(at: number): boolean {
    this.cancel();
    const inBurst = at - this.lastAt <= this.gapMs;
    this.lastAt = at;
    return inBurst;
  }

  /** Runs `act` once the scanner gap passes with no other key. */
  later(act: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      act();
    }, this.gapMs + 10);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

function isRowKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K';
}

const FOCUS_OWNERS = 'input, textarea, select, [data-row-id]';

/**
 * When no row has focus yet, J or K focuses the first list's current row (its roving tab stop), so
 * the keys work without clicking a row first. Rows then move themselves; an open drawer
 * (usePeekKeys) and the review queue handle the key first and mark it handled.
 */
export function usePageRowKeys({ now }: { now?: () => number } = {}): void {
  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  });

  useEffect(() => {
    const gate = new RowKeyGate();
    let burst = false;
    // Capture: sees every key first, even ones a page handles, so any key cancels a waiting J/K.
    const observe = (event: KeyboardEvent) => {
      burst = gate.key(nowRef.current ? nowRef.current() : event.timeStamp);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || burst || !isRowKey(event)) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (target.closest(FOCUS_OWNERS)) return;
      }
      gate.later(() => {
        if (document.querySelector(ROW_KEY_BLOCKERS)) return;
        // Something took focus meanwhile (a field, a row): leave it there.
        if (document.activeElement?.closest(FOCUS_OWNERS)) return;
        const table = document.querySelector<HTMLElement>('#main [data-slot="data-table"]');
        const row =
          table?.querySelector<HTMLElement>('tr[data-row-id][tabindex="0"]') ??
          table?.querySelector<HTMLElement>('tr[data-row-id]');
        row?.focus();
      });
    };
    window.addEventListener('keydown', observe, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      gate.cancel();
      window.removeEventListener('keydown', observe, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
