import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDraft } from '../draft';
import { DRAFT_RECORD_VERSION, newRecord } from './record';
import {
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_STORE_NAME,
  DraftStorageError,
  indexedDbDraftStore as store,
  toStorageError,
} from './store';

// IndexedDB draft store (TRP-T11 T1), against fake-indexeddb (see test-setup.ts).

const AT_ACCOUNT = { id: '00000000-0000-4000-8000-000000000102', accountType: 'test' as const };

function record(lastSavedAt: string, description = '') {
  const value = newRecord({ ...newDraft(null, '2026-10-26'), description }, AT_ACCOUNT);
  return { ...value, lastSavedAt };
}

/** Writes a raw value, bypassing the store (e.g. a record from another version). */
async function putRaw(value: unknown) {
  await store.list(); // creates the schema
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE_NAME, 'readwrite');
    tx.objectStore(DRAFT_STORE_NAME).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('draft store (TRP-T11)', () => {
  it('T1: creates its schema in an empty browser and round-trips records', async () => {
    expect(await store.list()).toEqual({ drafts: [], unreadable: 0 });
    const older = record('2026-10-26T16:00:00.000Z', 'older');
    const newer = record('2026-10-26T16:42:00.000Z', 'newer');
    await store.put(older);
    await store.put(newer);

    expect(await store.get(older.draftId)).toEqual(older);
    const { drafts } = await store.list();
    expect(drafts.map((d) => d.data.description)).toEqual(['newer', 'older']);

    await store.put({ ...older, status: 'confirming' });
    expect((await store.get(older.draftId))?.status).toBe('confirming');

    await store.remove(older.draftId);
    expect(await store.get(older.draftId)).toBeNull();
    expect((await store.list()).drafts).toHaveLength(1);
  });

  it('T1: keeps records it cannot read (newer version) and counts them', async () => {
    const future = { ...record('2026-10-26T16:00:00.000Z'), version: DRAFT_RECORD_VERSION + 1 };
    await putRaw(future);
    await store.put(record('2026-10-26T16:10:00.000Z'));
    const listing = await store.list();
    expect(listing.unreadable).toBe(1);
    expect(listing.drafts).toHaveLength(1);
    // Still there, untouched.
    await store.put(record('2026-10-26T16:20:00.000Z'));
    expect((await store.list()).unreadable).toBe(1);
  });

  it('AC3: reports storage failures instead of swallowing them', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const failed = store.put(record('2026-10-26T16:00:00.000Z'));
    await expect(failed).rejects.toBeInstanceOf(DraftStorageError);
    await expect(failed).rejects.toMatchObject({ problem: 'quota' });
  });

  it('reports a browser without IndexedDB (e.g. blocked storage) as unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(store.list()).rejects.toMatchObject({ problem: 'unavailable' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(toStorageError(new DOMException('no', 'SecurityError')).problem).toBe('unavailable');
    expect(toStorageError(new Error('other')).problem).toBe('failed');
  });
});
