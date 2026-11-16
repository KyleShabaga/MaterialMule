import type { ReceiverOption, StorageUnitRecordStatus } from '@materialmule/shared';
import type { MoveState, PlaceRef } from './store';

// The Move screen's own list (STRATA-80, round 3): shelf and unit labels in any order. A shelf
// label sets the destination for the units scanned after it; units scanned before any shelf wait
// for the first one. Nothing is queued until the person presses Save moves: then each ready row
// becomes one durable intent in the move queue (IndexedDB, MM-T28), with its own destination.
//
// The list belongs to this browser tab (sessionStorage), never to the LAB account: two LAB
// computers, or two tabs, each keep their own destination, person and scans.

/** What this computer knows about a scanned unit (the server's copy, or its last cached one). */
export interface UnitFacts {
  id: string;
  readableId: string;
  version: number;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  location: PlaceRef;
  recordStatus: StorageUnitRecordStatus | null;
  /** "DEMO-2615 · TH26-03 · Bucket"; null when only the cache knew the unit. */
  description: string | null;
  /** True when the facts came from this computer's cache (offline). */
  fromCache: boolean;
}

/**
 * Row problems never block the rest of the batch. `lookup`: scanned offline and unknown to this
 * computer (never invented; it waits for a lookup and the person's Save).
 */
export type UnitProblem = 'not_found' | 'disposed' | 'lookup';
export type ShelfProblem = 'retired' | 'not_found' | 'lookup';

export interface UnitItem {
  key: string;
  kind: 'unit';
  readableId: string;
  scannedAt: string;
  /** Later scans of the same label (ISO times): listed once. */
  repeats: string[];
  unit: UnitFacts | null;
  /** Where it goes: the shelf scanned before it, or null until a shelf is scanned. */
  destination: PlaceRef | null;
  problem: UnitProblem | null;
  /** Set when Save stored it in the queue; the queue then says what happened. */
  clientMoveId: string | null;
  /** Undone from the saved toast (lane 1C's compensating move). */
  undone?: boolean;
}

export interface ShelfItem {
  key: string;
  kind: 'shelf';
  /** The location code as scanned (LOC- removed). */
  code: string;
  place: PlaceRef | null;
  scannedAt: string;
  problem: ShelfProblem | null;
}

export type BatchItem = UnitItem | ShelfItem;

export interface LastSave {
  at: string;
  clientMoveIds: string[];
  /** Problem labels left out of the save ("3 labels weren't saved"). */
  dropped: number;
  /** The saved toast (with Undo) was shown for this save. */
  notified: boolean;
}

export interface BatchState {
  destination: PlaceRef | null;
  /** Chosen by hand on a LAB station; null follows the station's recording person. */
  mover: ReceiverOption | null;
  /** In scan order (oldest first); the screen shows the newest first. */
  items: BatchItem[];
  lastSave: LastSave | null;
}

const KEY = 'materialmule.moveBatch.v2';
export const EMPTY_BATCH: BatchState = {
  destination: null,
  mover: null,
  items: [],
  lastSave: null,
};

function isItem(value: unknown): value is BatchItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BatchItem>;
  return (
    typeof item.key === 'string' &&
    (item.kind === 'unit' || item.kind === 'shelf') &&
    typeof item.scannedAt === 'string'
  );
}

export function loadBatch(accountId: string): BatchState {
  try {
    const raw = window.sessionStorage.getItem(`${KEY}.${accountId}`);
    if (!raw) return EMPTY_BATCH;
    const parsed = JSON.parse(raw) as Partial<BatchState>;
    return {
      destination: parsed.destination ?? null,
      mover: parsed.mover ?? null,
      items: Array.isArray(parsed.items) ? parsed.items.filter(isItem) : [],
      lastSave: parsed.lastSave ?? null,
    };
  } catch {
    return EMPTY_BATCH;
  }
}

export function saveBatch(accountId: string, batch: BatchState): void {
  try {
    window.sessionStorage.setItem(`${KEY}.${accountId}`, JSON.stringify(batch));
  } catch {
    // Tab storage blocked: the list lives only while the page is open; the queue is unaffected.
  }
}

/** Unit rows not saved yet (no queue intent). */
export function draftUnits(items: readonly BatchItem[]): UnitItem[] {
  return items.filter((item): item is UnitItem => item.kind === 'unit' && !item.clientMoveId);
}

/**
 * The draft row this label already has (P20): a later scan of it is listed once and keeps the
 * row's destination; scanning another shelf in between never redirects it.
 */
export function findDraftUnit(items: readonly BatchItem[], readableId: string): UnitItem | null {
  return draftUnits(items).find((item) => item.readableId === readableId) ?? null;
}

/** Rows Save takes: known, not refused, with a destination. */
export function readyUnits(items: readonly BatchItem[]): UnitItem[] {
  return draftUnits(items).filter(
    (item) => item.problem === null && item.unit !== null && item.destination !== null,
  );
}

/** Known units still waiting for a shelf ("Scan a shelf label to set where these go"). */
export function unitsWithoutShelf(items: readonly BatchItem[]): UnitItem[] {
  return draftUnits(items).filter((item) => item.problem === null && item.destination === null);
}

/** Problem rows Save leaves out (an unknown-offline unit waits instead: it isn't a problem). */
export function problemItems(items: readonly BatchItem[]): BatchItem[] {
  return items.filter((item) =>
    item.kind === 'shelf'
      ? item.problem !== null && item.problem !== 'lookup'
      : !item.clientMoveId && item.problem !== null && item.problem !== 'lookup',
  );
}

/** A unit label joins the batch, going to the current destination (or waiting for one). */
export function addUnitItem(state: BatchState, item: Omit<UnitItem, 'destination'>): BatchState {
  const destination = item.problem === null || item.problem === 'lookup' ? state.destination : null;
  return { ...state, items: [...state.items, { ...item, destination }] };
}

/** A later scan of a label already in the batch: noted on its row, nothing else changes. */
export function repeatUnit(state: BatchState, key: string, at: string): BatchState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'unit' && item.key === key ? { ...item, repeats: [...item.repeats, at] } : item,
    ),
  };
}

/**
 * A shelf label. A usable one becomes the destination for the units scanned after it, and the
 * units waiting for a shelf take it; earlier rows keep theirs. A retired or unknown one is listed
 * as a problem and changes nothing.
 */
export function addShelfItem(state: BatchState, item: ShelfItem): BatchState {
  const items = [...state.items, item];
  if (item.problem !== null || !item.place) return { ...state, items };
  const place = item.place;
  return {
    ...state,
    destination: place,
    items: items.map((row) =>
      row.kind === 'unit' &&
      !row.clientMoveId &&
      row.destination === null &&
      (row.problem === null || row.problem === 'lookup')
        ? { ...row, destination: place }
        : row,
    ),
  };
}

/** Units scanned after this shelf row, for its "2 units" count. */
export function unitsAfterShelf(items: readonly BatchItem[], shelfKey: string): number {
  const index = items.findIndex((item) => item.key === shelfKey);
  const shelf = items[index];
  if (index < 0 || shelf?.kind !== 'shelf' || !shelf.place) return 0;
  const placeId = shelf.place.id;
  let count = 0;
  for (const item of items.slice(index + 1)) {
    if (item.kind === 'shelf' && item.problem === null) break;
    if (item.kind === 'unit' && item.problem === null && item.destination?.id === placeId) count++;
  }
  return count;
}

export function removeItem(state: BatchState, key: string): BatchState {
  return { ...state, items: state.items.filter((item) => item.key !== key) };
}

/** Replaces one row (a lookup that came back, say). */
export function replaceItem(state: BatchState, key: string, next: BatchItem): BatchState {
  return { ...state, items: state.items.map((item) => (item.key === key ? next : item)) };
}

/**
 * After Save: the saved rows carry their queue IDs; problem rows and shelf rows leave the list
 * (counted in `dropped`); rows still waiting (no shelf, needs a lookup) stay. The destination
 * stays chosen so the next units can go to the same shelf.
 */
export function markSaved(
  state: BatchState,
  saved: ReadonlyMap<string, string>,
  at: string,
): BatchState {
  const dropped = problemItems(state.items);
  const dropKeys = new Set(dropped.map((item) => item.key));
  const items = state.items
    .filter((item): item is UnitItem => item.kind === 'unit' && !dropKeys.has(item.key))
    .map((item) => {
      const clientMoveId = saved.get(item.key);
      return clientMoveId ? { ...item, clientMoveId } : item;
    });
  return {
    ...state,
    items,
    lastSave: {
      at,
      clientMoveIds: [...saved.values()],
      dropped: dropped.length,
      notified: false,
    },
  };
}

/**
 * The next scan after a save starts a new list: rows whose moves are settled leave it (they are
 * in each unit's history); rows the server hasn't answered stay visible until it does.
 */
export function startNewList(
  state: BatchState,
  stateOf: (clientMoveId: string) => MoveState | undefined,
): BatchState {
  if (!state.lastSave) return state;
  return {
    ...state,
    lastSave: null,
    items: state.items.filter((item) => {
      if (item.kind !== 'unit' || !item.clientMoveId) return true;
      const moveState = stateOf(item.clientMoveId);
      return moveState === 'pending' || moveState === 'waiting';
    }),
  };
}

/** Units on their way to `placeId` in this list and not already there (the shelf preview). */
export function comingTo(items: readonly BatchItem[], placeId: string): number {
  return readyUnits(items).filter(
    (item) => item.destination?.id === placeId && item.unit?.location.id !== placeId,
  ).length;
}

/** Other destinations of the ready rows, for "Earlier units go to WH-A-B3-S1 (2 units)". */
export function otherDestinations(
  items: readonly BatchItem[],
  placeId: string | null,
): { place: PlaceRef; count: number }[] {
  const byId = new Map<string, { place: PlaceRef; count: number }>();
  for (const item of readyUnits(items)) {
    const place = item.destination!;
    if (place.id === placeId) continue;
    const entry = byId.get(place.id) ?? { place, count: 0 };
    entry.count++;
    byId.set(place.id, entry);
  }
  return [...byId.values()];
}
