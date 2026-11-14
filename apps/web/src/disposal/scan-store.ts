import type { DisposalScanCheck, DisposalScanOutcome } from '@materialmule/shared';
import { toStorageError, type DraftStorageError } from '../receiving/drafts/store';

// Disposal scan intents of this browser profile (STRATA-92), in IndexedDB so they survive closing
// the tab or losing the connection. Every scan is written here, and the write has committed,
// before anything is sent: online scans too. An intent is only a scan: it never disposes anything
// by itself. Kyle's decision STRATA-112 (2026-11-13): after reconnecting, each queued intent is
// checked online again, and the person confirms the exact ID list before anything is recorded.
// The store never holds a password, cookie, CSRF value, token or session ID.
//
// Stores:
// * intents: one record per scan, keyed by intentId (a UUID made here, never reused), ordered by
//   `seq` (allocated in the same transaction as the write).
// * units: approved units this profile last saw online (readableId → location), so a scan taken
//   offline can say "approved when last checked" honestly. Nothing here is ever invented.

export const SCAN_DB_NAME = 'materialmule-disposal-scan';
export const SCAN_DB_VERSION = 1;
/** Record format; a record from a newer Material Mule is left untouched and never sent. */
export const SCAN_RECORD_VERSION = 1;

export type ScanStorageError = DraftStorageError;
export { toStorageError };

/**
 * queued: stored, not checked online since it was scanned (or since an unanswered recording).
 * checked: the server said what recording would do now (`check`). uncertain: a recording was
 * sent and no answer came back: it may have been recorded, so it is checked again before anything
 * else and can't be removed. done: the server answered the recording (`outcome`).
 */
export type ScanState = 'queued' | 'checked' | 'uncertain' | 'done';

export interface QueuedScan {
  recordVersion: typeof SCAN_RECORD_VERSION;
  intentId: string;
  seq: number;
  /** As scanned, trimmed and upper-cased; exactly what is sent. */
  code: string;
  scannedAt: string;
  /** Who was signed in at the scan; only that account may check or record it. */
  account: { id: string; name: string };
  state: ScanState;
  check: DisposalScanCheck | null;
  checkedAt: string | null;
  outcome: DisposalScanOutcome | null;
}

export interface CachedApproved {
  readableId: string;
  projectNumber: string;
  location: { code: string; name: string };
  cachedAt: string;
}

const INTENTS = 'intents';
const UNITS = 'units';
const META = 'meta';

export function upgradeScanDatabase(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(INTENTS, { keyPath: 'intentId' });
    db.createObjectStore(UNITS, { keyPath: 'readableId' });
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
      request = factory.open(SCAN_DB_NAME, SCAN_DB_VERSION);
    } catch (error) {
      reject(toStorageError(error));
      return;
    }
    request.onupgradeneeded = (event) => upgradeScanDatabase(request.result, event.oldVersion);
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

/** A stored record this version can read, or null (newer or damaged: left untouched). */
export function readQueuedScan(value: unknown): QueuedScan | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<QueuedScan>;
  if (record.recordVersion !== SCAN_RECORD_VERSION) return null;
  if (typeof record.intentId !== 'string' || typeof record.seq !== 'number') return null;
  if (typeof record.code !== 'string' || !record.account || typeof record.state !== 'string') {
    return null;
  }
  return record as QueuedScan;
}

export interface ScanList {
  scans: QueuedScan[];
  /** Records this version can't read; kept, never deleted or sent. */
  unreadable: number;
}

export type NewScan = Pick<QueuedScan, 'intentId' | 'code' | 'scannedAt' | 'account'>;

export interface ScanStore {
  list(): Promise<ScanList>;
  /** Stores a new intent (state queued); rejects if the ID already exists. */
  add(scan: NewScan): Promise<QueuedScan>;
  /** Updates state/check/outcome; the intent ID, code, account and time never change. */
  update(
    intentId: string,
    change: Partial<Pick<QueuedScan, 'state' | 'check' | 'checkedAt' | 'outcome'>>,
  ): Promise<void>;
  /** Removes intents the server never recorded (or whose outcome was shown). */
  remove(intentIds: string[]): Promise<void>;
  listApproved(): Promise<CachedApproved[]>;
  /** Replaces the cached approved list with what the server says now. */
  putApproved(units: CachedApproved[]): Promise<void>;
}

export const indexedDbScanStore: ScanStore = {
  async list() {
    const values = await run<unknown[]>([INTENTS], 'readonly', (transaction, done) => {
      const request = transaction.objectStore(INTENTS).getAll();
      request.onsuccess = () => done(request.result as unknown[]);
    });
    const scans: QueuedScan[] = [];
    let unreadable = 0;
    for (const value of values ?? []) {
      const scan = readQueuedScan(value);
      if (scan) scans.push(scan);
      else unreadable++;
    }
    scans.sort((a, b) => a.seq - b.seq);
    return { scans, unreadable };
  },

  add(scan) {
    return run<QueuedScan>([INTENTS, META], 'readwrite', (transaction, done) => {
      const meta = transaction.objectStore(META);
      const seqRequest = meta.get('seq');
      seqRequest.onsuccess = () => {
        const seq = ((seqRequest.result as number | undefined) ?? 0) + 1;
        meta.put(seq, 'seq');
        const record: QueuedScan = {
          ...scan,
          recordVersion: SCAN_RECORD_VERSION,
          seq,
          state: 'queued',
          check: null,
          checkedAt: null,
          outcome: null,
        };
        // add(), not put(): an existing intent is never overwritten.
        transaction.objectStore(INTENTS).add(record);
        done(record);
      };
    });
  },

  update(intentId, change) {
    return run<void>([INTENTS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(INTENTS);
      const request = store.get(intentId);
      request.onsuccess = () => {
        const current = readQueuedScan(request.result);
        if (current) store.put({ ...current, ...change });
      };
    });
  },

  remove(intentIds) {
    return run<void>([INTENTS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(INTENTS);
      for (const id of intentIds) store.delete(id);
    });
  },

  async listApproved() {
    return run<CachedApproved[]>([UNITS], 'readonly', (transaction, done) => {
      const request = transaction.objectStore(UNITS).getAll();
      request.onsuccess = () => done(request.result as CachedApproved[]);
    });
  },

  putApproved(units) {
    return run<void>([UNITS], 'readwrite', (transaction) => {
      const store = transaction.objectStore(UNITS);
      store.clear();
      for (const unit of units) store.put(unit);
    });
  },
};
