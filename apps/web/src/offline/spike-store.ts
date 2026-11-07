// MM-V2-C11 throwaway storage probes for the offline scenario checklist. Nothing else reads this
// database; C12 (local draft store) designs the real one from what these probes show.

export const SPIKE_DB = 'materialmule-offline-spike';
const DRAFTS = 'drafts';
const DEVICE = 'device';
const CHECKS = 'checks';
const FILLER = 'filler';
const DRAFT_ID = 'spike-draft';
const DEVICE_KEY = 'device';
const DEVICE_LOCAL_STORAGE_KEY = 'materialmule-spike:device';
const DEVICE_CACHE = 'mm-spike-device';
const DEVICE_CACHE_URL = '/__offline-spike/device.json';
const DEVICE_FILE = 'offline-spike-device.json';
const MB = 1024 * 1024;

export interface SpikeDraft {
  id: string;
  note: string;
  savedAt: string;
  shellVersion: string | null;
  /** Stored as a Blob, or as raw bytes (Blob storage has had platform bugs; C12 picks one). */
  photo: Blob | ArrayBuffer;
  photoFormat: PhotoFormat;
  photoName: string;
  photoType: string;
  photoSize: number;
  photoSha256: string;
}

export type PhotoFormat = 'blob' | 'arraybuffer';

export interface DraftCheck {
  found: boolean;
  savedAt?: string;
  ageDays?: number;
  note?: string;
  photoName?: string;
  photoSize?: number;
  photoFormat?: PhotoFormat;
  sizeMatches?: boolean;
  hashMatches?: boolean;
  savedWithShell?: string | null;
  error?: string;
}

export interface CheckEntry {
  id?: number;
  at: string;
  scenario: string;
  result: 'pass' | 'fail' | 'info';
  detail: string;
}

export interface DeviceValue {
  code: string;
  counter: number;
  updatedAt: string;
}

export type DeviceReading = { ok: true; value: DeviceValue | null } | { ok: false; error: string };

export interface DeviceReadings {
  indexedDb: DeviceReading;
  localStorage: DeviceReading;
  cacheStorage: DeviceReading;
  originPrivateFileSystem: DeviceReading;
}

/** "QuotaExceededError: …" style text for any thrown value; shown to the tester as-is. */
export function describeError(error: unknown): string {
  if (error instanceof DOMException || error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function openSpikeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SPIKE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(DRAFTS, { keyPath: 'id' });
      db.createObjectStore(DEVICE, { keyPath: 'key' });
      db.createObjectStore(CHECKS, { keyPath: 'id', autoIncrement: true });
      db.createObjectStore(FILLER, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
    request.onblocked = () => reject(new Error('indexedDB.open blocked by another tab'));
  });
}

/** Runs `work` in one transaction and settles only when the transaction commits or fails. */
async function inTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openSpikeDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T | undefined;
      const request = work(tx);
      if (request) request.onsuccess = () => (result = request.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

// Tag checks, not instanceof: IndexedDB may hand back objects from another realm.
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';
const isBlob = (value: unknown): value is Blob =>
  typeof value === 'object' && value !== null && typeof (value as Blob).arrayBuffer === 'function';

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const bytes = isArrayBuffer(data) ? data : await data.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Random bytes, so no layer (IndexedDB, OS, browser) can compress the test photo away. */
export function randomBlob(bytes: number, type = 'application/octet-stream'): Blob {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes; offset += 65536) {
    const part = new Uint8Array(Math.min(65536, bytes - offset));
    crypto.getRandomValues(part);
    parts.push(part);
  }
  return new Blob(parts as BlobPart[], { type });
}

export async function saveDraft(input: {
  note: string;
  photo: Blob;
  photoName: string;
  photoFormat?: PhotoFormat;
  shellVersion: string | null;
  now?: Date;
}): Promise<SpikeDraft> {
  const photoFormat = input.photoFormat ?? 'blob';
  const record: SpikeDraft = {
    id: DRAFT_ID,
    note: input.note,
    savedAt: (input.now ?? new Date()).toISOString(),
    shellVersion: input.shellVersion,
    photo: photoFormat === 'blob' ? input.photo : await input.photo.arrayBuffer(),
    photoFormat,
    photoName: input.photoName,
    photoType: input.photo.type,
    photoSize: input.photo.size,
    photoSha256: await sha256Hex(input.photo),
  };
  await inTransaction([DRAFTS], 'readwrite', (tx) => tx.objectStore(DRAFTS).put(record));
  return record;
}

export async function readDraft(): Promise<SpikeDraft | null> {
  const record = await inTransaction<SpikeDraft>([DRAFTS], 'readonly', (tx) =>
    tx.objectStore(DRAFTS).get(DRAFT_ID),
  );
  return record ?? null;
}

/** Reads the draft back and re-hashes the stored photo bytes. */
export async function checkDraft(now = new Date()): Promise<DraftCheck> {
  try {
    const record = await readDraft();
    if (!record) return { found: false };
    const photo = record.photo;
    const stored = isBlob(photo) || isArrayBuffer(photo);
    const size = isBlob(photo) ? photo.size : isArrayBuffer(photo) ? photo.byteLength : -1;
    const hash = stored ? await sha256Hex(photo) : null;
    return {
      found: true,
      savedAt: record.savedAt,
      ageDays: (now.getTime() - Date.parse(record.savedAt)) / 86_400_000,
      note: record.note,
      photoName: record.photoName,
      photoSize: record.photoSize,
      photoFormat: record.photoFormat,
      sizeMatches: size === record.photoSize,
      hashMatches: hash === record.photoSha256,
      savedWithShell: record.shellVersion,
    };
  } catch (error) {
    return { found: false, error: describeError(error) };
  }
}

export async function addCheck(entry: CheckEntry): Promise<void> {
  await inTransaction([CHECKS], 'readwrite', (tx) => tx.objectStore(CHECKS).add(entry));
}

export async function listChecks(): Promise<CheckEntry[]> {
  return (
    (await inTransaction<CheckEntry[]>([CHECKS], 'readonly', (tx) =>
      tx.objectStore(CHECKS).getAll(),
    )) ?? []
  );
}

// --- Device code and counter: the same value in every store a browser offers ---------------

function newDeviceCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'DEV-' + [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  return typeof navigator.storage?.getDirectory === 'function'
    ? navigator.storage.getDirectory()
    : null;
}

async function settle(read: () => Promise<DeviceValue | null>): Promise<DeviceReading> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function readDevice(): Promise<DeviceReadings> {
  return {
    indexedDb: await settle(async () => {
      const row = await inTransaction<DeviceValue & { key: string }>([DEVICE], 'readonly', (tx) =>
        tx.objectStore(DEVICE).get(DEVICE_KEY),
      );
      return row ? { code: row.code, counter: row.counter, updatedAt: row.updatedAt } : null;
    }),
    localStorage: await settle(async () => {
      const raw = localStorage.getItem(DEVICE_LOCAL_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as DeviceValue) : null;
    }),
    cacheStorage: await settle(async () => {
      if (typeof caches === 'undefined') throw new Error('Cache Storage not available');
      const response = await (await caches.open(DEVICE_CACHE)).match(DEVICE_CACHE_URL);
      return response ? ((await response.json()) as DeviceValue) : null;
    }),
    originPrivateFileSystem: await settle(async () => {
      const root = await opfsRoot();
      if (!root) throw new Error('Origin private file system not available');
      try {
        const file = await (await root.getFileHandle(DEVICE_FILE)).getFile();
        return JSON.parse(await file.text()) as DeviceValue;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return null;
        throw error;
      }
    }),
  };
}

/** Writes the value to every store; IndexedDB is the source of truth for the next increment. */
export async function writeDevice(
  value: DeviceValue,
): Promise<Record<keyof DeviceReadings, string>> {
  const attempt = async (write: () => Promise<void>) => {
    try {
      await write();
      return 'written';
    } catch (error) {
      return describeError(error);
    }
  };
  return {
    indexedDb: await attempt(async () => {
      await inTransaction([DEVICE], 'readwrite', (tx) =>
        tx.objectStore(DEVICE).put({ key: DEVICE_KEY, ...value }),
      );
    }),
    localStorage: await attempt(async () => {
      localStorage.setItem(DEVICE_LOCAL_STORAGE_KEY, JSON.stringify(value));
    }),
    cacheStorage: await attempt(async () => {
      if (typeof caches === 'undefined') throw new Error('Cache Storage not available');
      const cache = await caches.open(DEVICE_CACHE);
      await cache.put(
        DEVICE_CACHE_URL,
        new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }),
      );
    }),
    originPrivateFileSystem: await attempt(async () => {
      const root = await opfsRoot();
      if (!root) throw new Error('Origin private file system not available');
      const handle = await root.getFileHandle(DEVICE_FILE, { create: true });
      if (typeof handle.createWritable !== 'function') {
        throw new Error('createWritable not supported (Safari: worker-only sync access)');
      }
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(value));
      await writable.close();
    }),
  };
}

export async function createDevice(now = new Date()) {
  return writeDevice({ code: newDeviceCode(), counter: 0, updatedAt: now.toISOString() });
}

export async function incrementDeviceCounter(now = new Date()) {
  const current = (await readDevice()).indexedDb;
  if (!current.ok || !current.value) {
    throw new Error('No device code in IndexedDB; create one first');
  }
  return writeDevice({
    code: current.value.code,
    counter: current.value.counter + 1,
    updatedAt: now.toISOString(),
  });
}

// --- Low storage: fill the origin until a write fails ----------------------------------------

export interface FillResult {
  writtenMb: number;
  stoppedBy: 'error' | 'limit' | 'cancelled';
  error?: string;
}

export async function fillStorage(options: {
  chunkMb: number;
  limitMb: number;
  signal?: AbortSignal;
  onProgress?: (writtenMb: number) => void;
}): Promise<FillResult> {
  let written = 0;
  while (written < options.limitMb) {
    if (options.signal?.aborted) return { writtenMb: written, stoppedBy: 'cancelled' };
    const chunk = randomBlob(options.chunkMb * MB);
    try {
      await inTransaction([FILLER], 'readwrite', (tx) => tx.objectStore(FILLER).add(chunk));
    } catch (error) {
      return { writtenMb: written, stoppedBy: 'error', error: describeError(error) };
    }
    written += options.chunkMb;
    options.onProgress?.(written);
  }
  return { writtenMb: written, stoppedBy: 'limit' };
}

export async function clearFiller(): Promise<void> {
  await inTransaction([FILLER], 'readwrite', (tx) => tx.objectStore(FILLER).clear());
}

/** Removes every probe: the spike database, device copies in other stores. */
export async function deleteAllSpikeData(): Promise<void> {
  try {
    localStorage.removeItem(DEVICE_LOCAL_STORAGE_KEY);
  } catch {
    // ignore: nothing to remove
  }
  if (typeof caches !== 'undefined') await caches.delete(DEVICE_CACHE);
  const root = await opfsRoot().catch(() => null);
  await root?.removeEntry(DEVICE_FILE).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SPIKE_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
    request.onblocked = () => reject(new Error('deleteDatabase blocked by another tab'));
  });
}
