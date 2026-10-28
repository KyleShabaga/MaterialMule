import type { ReceiverOption } from '@materialmule/shared';
import type { PlaceRef } from './store';

// The Move screen's own state (MM-T28): destination, "Moved by" and this batch's scans. It
// belongs to this browser tab (sessionStorage), never to the LAB account: two LAB computers, or
// two tabs, each keep their own destination and person. The queue itself is in IndexedDB.

export type BatchItem =
  | {
      key: string;
      kind: 'move';
      clientMoveId: string;
      readableId: string;
      unitId: string;
      destination: PlaceRef;
    }
  | {
      /** Scanned offline and not in this computer's cache: identity unknown, nothing queued. */
      key: string;
      kind: 'lookup';
      readableId: string;
      destination: PlaceRef;
      scannedAt: string;
    };

export interface BatchState {
  destination: PlaceRef | null;
  mover: ReceiverOption | null;
  items: BatchItem[];
}

const KEY = 'materialmule.moveBatch';
export const EMPTY_BATCH: BatchState = { destination: null, mover: null, items: [] };

export function loadBatch(accountId: string): BatchState {
  try {
    const raw = window.sessionStorage.getItem(`${KEY}.${accountId}`);
    if (!raw) return EMPTY_BATCH;
    const parsed = JSON.parse(raw) as Partial<BatchState>;
    return {
      destination: parsed.destination ?? null,
      mover: parsed.mover ?? null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return EMPTY_BATCH;
  }
}

export function saveBatch(accountId: string, batch: BatchState): void {
  try {
    window.sessionStorage.setItem(`${KEY}.${accountId}`, JSON.stringify(batch));
  } catch {
    // Tab storage blocked: the batch lives only while the page is open; the queue is unaffected.
  }
}

/**
 * True when this unit is already in the batch for this destination (P20). The scanner's own
 * two-second filter only catches the same label twice in a row; this also catches A → B → A.
 * A move that was dismissed doesn't count.
 */
export function inBatch(
  items: BatchItem[],
  readableId: string,
  destinationId: string,
  dismissed: ReadonlySet<string> = new Set(),
): boolean {
  return items.some(
    (item) =>
      item.readableId === readableId &&
      item.destination.id === destinationId &&
      !(item.kind === 'move' && dismissed.has(item.clientMoveId)),
  );
}
