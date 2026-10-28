import type { MoveRequest } from '@materialmule/shared';
import { toStorageError, type DraftStorageError } from '../receiving/drafts/store';

// The move queue of this browser profile (MM-T28), in IndexedDB so it survives closing the tab
// or the browser. Every scan intent is written here, and the write has committed, before it is
// sent: online scans too. The queue never holds a password, cookie, CSRF value, token or session
// ID: only the frozen request body and what the screen needs to describe it.
//
// Stores:
// * actions: one record per scan intent, keyed by clientMoveId, ordered by `seq` (allocated in
//   the same transaction as the write, so tabs of one profile never share a number).
// * units / locations: the last server copy of each storage unit and location this profile saw,
//   so a scan taken offline can name the unit and its last known version honestly. Nothing here
//   is ever invented: an unknown code stays "Needs online lookup".

export const MOVE_DB_NAME = 'materialmule-moves';
export const MOVE_DB_VERSION = 1;
/** Record format; a record from a newer Material Mule is left untouched and reported. */
export const MOVE_RECORD_VERSION = 1;

export type MoveStorageError = DraftStorageError;
export { toStorageError };

/**
 * Pending: stored, not yet answered (it may have been sent: the outcome is unknown until the
 * server answers a retry). Waiting: held behind an earlier move of the same unit. Attention: the
 * server refused it for good; nothing was recorded. Dismissed: a person cleared a held or refused
 * intent that the server never recorded.
 */
export type MoveState = 'pending' | 'waiting' | 'saved' | 'conflict' | 'attention' | 'dismissed';

export interface PlaceRef {
  id: string;
  code: string;
  name: string;
}

export interface QueuedMove {
  recordVersion: typeof MOVE_RECORD_VERSION;
  clientMoveId: string;
  seq: number;
  createdAt: string;
  /** Exactly what is sent, on every attempt. Never edited after it is stored. */
  request: MoveRequest;
  unit: { id: string; readableId: string };
  /** The saved location and version the scan was based on (last synced, not verified). */
  base: { version: number; location: PlaceRef };
  destination: PlaceRef;
  /** Who was signed in at the scan, for display; the server checks the real session. */
  account: { id: string; name: string };
  mover: { id: string; initials: string | null; name: string } | null;
  state: MoveState;
  attempts: number;
  /** The last problem in words, or why it waits. */
  message: string | null;
  result: {
    movementEventId?: string;
    resultingVersion?: number;
    conflictId?: string;
    savedAt?: string;
  } | null;
}

export interface CachedUnit {
  readableId: string;
  id: string;
  version: number;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  location: PlaceRef;
  cachedAt: string;
}

export interface CachedLocation extends PlaceRef {
  active: boolean;
  cachedAt: string;
}

const ACTIONS = 'actions';
const UNITS = 'units';
const LOCATIONS = 'locations';
const META = 'meta';

export function upgradeMoveDatabase(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(ACTIONS, { keyPath: 'clientMoveId' });
    db.createObjectStore(UNITS, { keyPath: 'readableId' });
    db.createObjectStore(LOCATIONS, { keyPath: 'code' });
    db.createObjectStore(META);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB as IDBFactory | undefined;
    if (!factory) {
      reject(toStorageError(new DOMException('No IndexedDB', 'SecurityError')));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(MOVE_DB_NAME, MOVE_DB_VERSION);
    } catch (error) {
      reject(toStorageError(error));
      return;
    }
    request.onupgradeneeded = (event) => upgradeMoveDatabase(request.result, event.oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageError(request.error));
  });
}

/** One transaction; resolves only after it commits, so a resolved write is durable. */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction, done: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      let result: T;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(stores, mode);
        work(transaction, (value) => {
          result = value;
        });
      } catch (error) {
        reject(toStorageError(error));
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(toStorageError(transaction.error));
      transaction.onabort = () => reject(toStorageError(transaction.error));
    });
  } finally {
    db.close();
  }
}

function getAll<T>(transaction: IDBTransaction, store: string, done: (value: T[]) => void) {
  const request = transaction.objectStore(store).getAll();
  request.onsuccess = () => done(request.result as T[]);
}

/** A stored record this version can read, or null (newer or damaged: left untouched). */
export function readQueuedMove(value: unknown): QueuedMove | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<QueuedMove>;
  if (record.recordVersion !== MOVE_RECORD_VERSION) return null;
  if (typeof record.clientMoveId !== 'string' || typeof record.seq !== 'number') return null;
  if (!record.request || !record.unit || !record.destination || !record.base) return null;
  return record as QueuedMove;
}

export interface MoveList {
  moves: QueuedMove[];
  /** Records this version can't read; kept, never deleted or sent. */
  unreadable: number;
}

export type NewMove = Omit<QueuedMove, 'seq' | 'createdAt' | 'recordVersion'>;

export interface MoveStore {
  list(): Promise<MoveList>;
  /** Stores a new intent with the next sequence number; rejects if the ID already exists. */
  add(move: NewMove): Promise<QueuedMove>;
  /** Updates state/attempts/message/result of a stored intent; the request never changes. */
  update(
    clientMoveId: string,
    change: Partial<Pick<QueuedMove, 'state' | 'attempts' | 'message' | 'result'>>,
  ): Promise<void>;
  getUnit(readableId: string): Promise<CachedUnit | null>;
  /** Keeps the newer of the stored and given copies (by version). */
  putUnit(unit: CachedUnit): Promise<void>;
  getLocation(code: string): Promise<CachedLocation | null>;
  putLocations(locations: CachedLocation[]): Promise<void>;
}

export const indexedDbMoveStore: MoveStore = {
  async list() {
    const values = await run<unknown[]>([ACTIONS], 'readonly', (transaction, done) =>
      getAll(transaction, ACTIONS, done),
    );
    const moves: QueuedMove[] = [];
    let unreadable = 0;
    for (const value of values ?? []) {
      const move = readQueuedMove(value);
      if (move) moves.push(move);
      else unreadable++;
    }
    moves.sort((a, b) => a.seq - b.seq);
    return { moves, unreadable };
  },

  add(move) {
    return run<QueuedMove>([ACTIONS, META], 'readwrite', (transaction, done) => {
      const meta = transaction.objectStore(META);
      const seqRequest = meta.get('seq');
      seqRequest.onsuccess = () => {
        const seq = ((seqRequest.result as number | undefined) ?? 0) + 1;
        meta.put(seq, 'seq');
        const record: QueuedMove = {
          ...move,
          recordVersion: MOVE_RECORD_VERSION,
          seq,
          createdAt: new Date().toISOString(),
        };
        // add(), not put(): an existing intent is never overwritten.
        transaction.objectStore(ACTIONS).add(record);
        done(record);
      };
    });
  },

  update(clientMoveId, change) {
    return run<void>([ACTIONS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(ACTIONS);
      const request = store.get(clientMoveId);
      request.onsuccess = () => {
        const current = readQueuedMove(request.result);
        if (current) store.put({ ...current, ...change });
      };
    });
  },

  async getUnit(readableId) {
    return run<CachedUnit | null>([UNITS], 'readonly', (transaction, done) => {
      const request = transaction.objectStore(UNITS).get(readableId);
      request.onsuccess = () => done((request.result as CachedUnit | undefined) ?? null);
    });
  },

  putUnit(unit) {
    return run<void>([UNITS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(UNITS);
      const request = store.get(unit.readableId);
      request.onsuccess = () => {
        const current = request.result as CachedUnit | undefined;
        if (!current || current.version <= unit.version) store.put(unit);
      };
    });
  },

  async getLocation(code) {
    return run<CachedLocation | null>([LOCATIONS], 'readonly', (transaction, done) => {
      const request = transaction.objectStore(LOCATIONS).get(code);
      request.onsuccess = () => done((request.result as CachedLocation | undefined) ?? null);
    });
  },

  putLocations(locations) {
    return run<void>([LOCATIONS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(LOCATIONS);
      for (const location of locations) store.put(location);
    });
  },
};

const STATION_KEY = 'materialmule.moveStation';

/**
 * Random ID of this browser profile's move queue. Not a session, token or device fingerprint;
 * it lets history tell two LAB computers apart and keeps a predecessor chain to one station.
 */
export function stationId(): string {
  try {
    const existing = window.localStorage.getItem(STATION_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(STATION_KEY, id);
    return id;
  } catch {
    // Storage blocked: the queue can't persist either, and the page says so.
    return crypto.randomUUID();
  }
}
