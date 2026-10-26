import { upgradeRecord, type StoredDraft } from './record';

// IndexedDB store for receiving drafts on this browser (TRP-T11). A connection is opened per
// operation and closed again, so a newer tab can upgrade the schema without being blocked.
// Every failure (blocked storage, private mode, full disk) is reported to the caller as a
// DraftStorageError; nothing is swallowed, so the wizard never shows a failed save as saved.

export const DRAFT_DB_NAME = 'trapezoid-drafts';
/** IndexedDB schema version. Bump it and add a step in upgradeDatabase when stores change. */
export const DRAFT_DB_VERSION = 1;
export const DRAFT_STORE_NAME = 'receiptDrafts';

export type DraftStorageProblem = 'unavailable' | 'quota' | 'failed';

export class DraftStorageError extends Error {
  constructor(
    readonly problem: DraftStorageProblem,
    message: string,
  ) {
    super(message);
    this.name = 'DraftStorageError';
  }
}

const MESSAGES: Record<DraftStorageProblem, string> = {
  unavailable:
    "This browser doesn't allow saving drafts here (private browsing or blocked site data).",
  quota: 'This computer has no storage space left for drafts.',
  failed: 'The browser refused to save the draft.',
};

export function toStorageError(error: unknown): DraftStorageError {
  if (error instanceof DraftStorageError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  const problem: DraftStorageProblem =
    name === 'QuotaExceededError'
      ? 'quota'
      : name === 'SecurityError' || name === 'InvalidStateError'
        ? 'unavailable'
        : 'failed';
  return new DraftStorageError(problem, MESSAGES[problem]);
}

/** Schema upgrades, one step per version, from whatever version this browser has. */
export function upgradeDatabase(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(DRAFT_STORE_NAME, { keyPath: 'draftId' });
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB as IDBFactory | undefined;
    if (!factory) {
      reject(new DraftStorageError('unavailable', MESSAGES.unavailable));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    } catch (error) {
      reject(toStorageError(error));
      return;
    }
    request.onupgradeneeded = (event) => upgradeDatabase(request.result, event.oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageError(request.error));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      let result: T;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(DRAFT_STORE_NAME, mode);
        const request = work(transaction.objectStore(DRAFT_STORE_NAME));
        if (request) {
          request.onsuccess = () => {
            result = request.result as T;
          };
        }
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

const pending = new Set<Promise<unknown>>();

/** Registers a queued draft write, so draftWritesSettled() can wait for it. */
export function trackDraftWrite<T>(write: Promise<T>): Promise<T> {
  pending.add(write);
  const done = () => pending.delete(write);
  write.then(done, done);
  return write;
}

/** Resolves once every queued draft write has finished (used between tests). */
export async function draftWritesSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export interface DraftList {
  drafts: StoredDraft[];
  /** Records this version can't read (e.g. saved by a newer Trapezoid); left untouched. */
  unreadable: number;
}

export interface DraftStore {
  list(): Promise<DraftList>;
  get(draftId: string): Promise<StoredDraft | null>;
  put(record: StoredDraft): Promise<void>;
  remove(draftId: string): Promise<void>;
}

export const indexedDbDraftStore: DraftStore = {
  async list() {
    const values = await run<unknown[]>('readonly', (store) => store.getAll());
    const drafts: StoredDraft[] = [];
    let unreadable = 0;
    for (const value of values ?? []) {
      const record = upgradeRecord(value);
      if (record) drafts.push(record);
      else unreadable++;
    }
    drafts.sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt));
    return { drafts, unreadable };
  },
  async get(draftId) {
    return upgradeRecord(await run<unknown>('readonly', (store) => store.get(draftId)));
  },
  async put(record) {
    await run('readwrite', (store) => store.put(record));
  },
  async remove(draftId) {
    await run('readwrite', (store) => store.delete(draftId));
  },
};
