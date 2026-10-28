import type { MoveRequest } from '@materialmule/shared';
import { describe, expect, it, vi } from 'vitest';
import { inBatch, type BatchItem } from './batch';
import { isoWithOffset } from './format';
import {
  classifyResponse,
  drainQueue,
  predecessorFor,
  retryDelay,
  type SendOutcome,
} from './queue';
import {
  indexedDbMoveStore as store,
  MOVE_DB_NAME,
  MOVE_DB_VERSION,
  type NewMove,
  type QueuedMove,
} from './store';

// MM-T28 test plan T1 and section 12 P02–P04, P12, P20, P21 in the browser queue, against
// fake-indexeddb (see test-setup.ts). Fictional IDs only.

const LAB = '00000000-0000-4000-8000-0000000e1801';
const TECH = '00000000-0000-4000-8000-000000000102';
const STATION = '3b4b0c5e-2d0a-4f7e-9a51-6f0c7c0b9e02';
const C1 = { id: '00000000-0000-4000-8000-000000000601', code: 'WH-C1', name: 'Warehouse C1' };
const C2 = { id: '00000000-0000-4000-8000-000000000602', code: 'WH-C2', name: 'Warehouse C2' };
const RECEIVING = {
  id: '00000000-0000-4000-8000-000000000600',
  code: 'RECEIVING',
  name: 'Receiving lab',
};
const U1 = { id: '00000000-0000-4000-8000-000000000501', readableId: 'BKT-2026-000014' };
const U2 = { id: '00000000-0000-4000-8000-000000000502', readableId: 'BKT-2026-000015' };

function newMove(
  unit: { id: string; readableId: string },
  destination: typeof C1,
  options: { account?: string; previous?: QueuedMove; baseVersion?: number } = {},
): NewMove {
  const clientMoveId = crypto.randomUUID();
  const request: MoveRequest = {
    clientMoveId,
    storageUnitId: unit.id,
    toLocationId: destination.id,
    baseVersion: options.previous?.request.baseVersion ?? options.baseVersion ?? 1,
    scannedAt: '2026-10-27T09:15:00.000-06:00',
    capturedOffline: true,
    ...(options.previous ? { previousClientMoveId: options.previous.clientMoveId } : {}),
    captureContext: { stationId: STATION, accountId: options.account ?? LAB },
  };
  return {
    clientMoveId,
    request,
    unit,
    base: { version: request.baseVersion, location: RECEIVING },
    destination,
    account: { id: options.account ?? LAB, name: 'LAB' },
    mover: null,
    state: 'pending',
    attempts: 0,
    message: null,
    result: null,
  };
}

const saved = (request: MoveRequest, version: number): SendOutcome => ({
  kind: 'saved',
  body: {
    outcome: 'saved',
    clientMoveId: request.clientMoveId,
    movementEventId: crypto.randomUUID(),
    appliedToLocationId: request.toLocationId,
    resultingVersion: version,
    savedAt: '2026-10-27T15:20:00.000Z',
    replayed: false,
  },
});

const conflict = (request: MoveRequest): SendOutcome => ({
  kind: 'conflict',
  body: {
    code: 'location_conflict',
    outcome: 'conflict',
    message: 'This storage unit changed after the scan.',
    clientMoveId: request.clientMoveId,
    attemptEventId: crypto.randomUUID(),
    conflictId: crypto.randomUUID(),
    currentVersion: 2,
    replayed: false,
  },
});

async function states() {
  const { moves } = await store.list();
  return moves.map((move) => [move.unit.readableId, move.destination.code, move.state]);
}

describe('move queue store', () => {
  it('P02/P03: a stored intent keeps its ID, payload and order; sequence numbers never repeat', async () => {
    const a = await store.add(newMove(U1, C2));
    const b = await store.add(newMove(U2, C2));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    const { moves } = await store.list();
    expect(moves.map((m) => m.clientMoveId)).toEqual([a.clientMoveId, b.clientMoveId]);
    expect(moves[0]!.request).toEqual(a.request);
    // Adding the same intent again never overwrites it.
    await expect(store.add({ ...newMove(U1, C1), clientMoveId: a.clientMoveId })).rejects.toThrow();
    expect((await store.list()).moves[0]!.destination).toEqual(C2);
  });

  it('P04: a failed write is reported and nothing is stored', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await expect(store.add(newMove(U1, C2))).rejects.toMatchObject({ problem: 'quota' });
    vi.restoreAllMocks();
    expect((await store.list()).moves).toEqual([]);
  });

  it('P21: a record from a newer version is kept and reported, never sent or deleted', async () => {
    await store.list();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MOVE_DB_NAME, MOVE_DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('actions', 'readwrite');
      tx.objectStore('actions').put({ clientMoveId: 'future', recordVersion: 99 });
      tx.oncomplete = () => resolve();
    });
    db.close();
    const send = vi.fn();
    expect(await store.list()).toEqual({ moves: [], unreadable: 1 });
    await drainQueue({ store, accountId: LAB, send });
    expect(send).not.toHaveBeenCalled();
    expect((await store.list()).unreadable).toBe(1);
  });

  it('keeps the newer cached copy of a unit', async () => {
    const unit = { ...U1, version: 3, status: 'in_stock' as const, location: C1, cachedAt: 'x' };
    await store.putUnit(unit);
    await store.putUnit({ ...unit, version: 2, location: C2 });
    expect(await store.getUnit(U1.readableId)).toMatchObject({ version: 3, location: C1 });
  });
});

describe('draining the queue (T1)', () => {
  it('sends in scan order and records each outcome', async () => {
    const first = await store.add(newMove(U1, C2));
    const second = await store.add(newMove(U2, C2));
    const send = vi.fn(async (request: MoveRequest) => saved(request, 2));
    const result = await drainQueue({ store, accountId: LAB, send });
    expect(result.stop).toBeNull();
    expect(send.mock.calls.map(([request]) => request.clientMoveId)).toEqual([
      first.clientMoveId,
      second.clientMoveId,
    ]);
    // Sent exactly as stored.
    expect(send.mock.calls[0]![0]).toEqual(first.request);
    expect(await states()).toEqual([
      ['BKT-2026-000014', 'WH-C2', 'saved'],
      ['BKT-2026-000015', 'WH-C2', 'saved'],
    ]);
  });

  it('P08: no answer keeps the move pending with the same ID; the next drain resends it unchanged', async () => {
    const move = await store.add(newMove(U1, C2));
    const unavailable = vi.fn(async (): Promise<SendOutcome> => ({ kind: 'unavailable' }));
    expect((await drainQueue({ store, accountId: LAB, send: unavailable })).stop).toBe(
      'unavailable',
    );
    expect(await states()).toEqual([['BKT-2026-000014', 'WH-C2', 'pending']]);
    const send = vi.fn(async (request: MoveRequest) => saved(request, 2));
    await drainQueue({ store, accountId: LAB, send });
    expect(send.mock.calls[0]![0]).toEqual(move.request);
    expect((await store.list()).moves[0]!.attempts).toBe(2);
  });

  it('P11/P12: a conflict holds the later move of that unit; other units still sync', async () => {
    const first = await store.add(newMove(U1, C1));
    const linked = await store.add(newMove(U1, C2, { previous: first }));
    const other = await store.add(newMove(U2, C2));
    const send = vi.fn(async (request: MoveRequest) =>
      request.clientMoveId === first.clientMoveId ? conflict(request) : saved(request, 2),
    );
    await drainQueue({ store, accountId: LAB, send });
    expect(send.mock.calls.map(([r]) => r.clientMoveId)).toEqual([
      first.clientMoveId,
      other.clientMoveId,
    ]);
    expect(await states()).toEqual([
      ['BKT-2026-000014', 'WH-C1', 'conflict'],
      ['BKT-2026-000014', 'WH-C2', 'waiting'],
      ['BKT-2026-000015', 'WH-C2', 'saved'],
    ]);
    const held = (await store.list()).moves.find((m) => m.clientMoveId === linked.clientMoveId)!;
    expect(held.message).toMatch(/location conflict/);
    // It stays held on later drains; never sent on its own.
    send.mockClear();
    await drainQueue({ store, accountId: LAB, send });
    expect(send).not.toHaveBeenCalled();
  });

  it('a linked move follows its predecessor once that saves', async () => {
    const first = await store.add(newMove(U1, C1));
    const linked = await store.add(newMove(U1, C2, { previous: first }));
    const send = vi.fn(async (request: MoveRequest) =>
      saved(request, request.clientMoveId === first.clientMoveId ? 2 : 3),
    );
    await drainQueue({ store, accountId: LAB, send });
    expect(send.mock.calls.map(([r]) => r.clientMoveId)).toEqual([
      first.clientMoveId,
      linked.clientMoveId,
    ]);
    // Both share the base the station saw; the server uses the predecessor's result.
    expect(linked.request.baseVersion).toBe(first.request.baseVersion);
  });

  it('P13/P14: an expired session pauses the whole queue without changing any move', async () => {
    await store.add(newMove(U1, C2));
    await store.add(newMove(U2, C2));
    const send = vi.fn(async (): Promise<SendOutcome> => ({ kind: 'unauthenticated' }));
    expect((await drainQueue({ store, accountId: LAB, send })).stop).toBe('unauthenticated');
    expect(send).toHaveBeenCalledTimes(1);
    expect(await states()).toEqual([
      ['BKT-2026-000014', 'WH-C2', 'pending'],
      ['BKT-2026-000015', 'WH-C2', 'pending'],
    ]);
  });

  it('P15: another account never sends (or adopts) this account’s queued moves', async () => {
    await store.add(newMove(U1, C2, { account: LAB }));
    const send = vi.fn();
    await drainQueue({ store, accountId: TECH, send });
    expect(send).not.toHaveBeenCalled();
    expect(await states()).toEqual([['BKT-2026-000014', 'WH-C2', 'pending']]);
  });

  it('P16: a terminal refusal needs attention and is not retried', async () => {
    await store.add(newMove(U1, C2));
    const send = vi.fn(async () =>
      classifyResponse(422, { code: 'storage_unit_disposed', message: 'x' }),
    );
    await drainQueue({ store, accountId: LAB, send });
    await drainQueue({ store, accountId: LAB, send });
    expect(send).toHaveBeenCalledTimes(1);
    const [move] = (await store.list()).moves;
    expect(move).toMatchObject({ state: 'attention', message: expect.stringMatching(/disposed/) });
  });
});

describe('response rules', () => {
  it('classifies every answer the server can give', () => {
    expect(classifyResponse(null, null).kind).toBe('unavailable');
    expect(classifyResponse(503, null).kind).toBe('unavailable');
    expect(classifyResponse(401, null).kind).toBe('unauthenticated');
    expect(classifyResponse(403, { code: 'forbidden' }).kind).toBe('forbidden');
    expect(classifyResponse(403, { code: 'capture_account_mismatch' }).kind).toBe('refused');
    expect(classifyResponse(409, { code: 'predecessor_not_applied', message: 'wait' })).toEqual({
      kind: 'waiting',
      message: 'wait',
    });
    expect(classifyResponse(409, { code: 'idempotency_key_reused' }).kind).toBe('refused');
    expect(classifyResponse(422, { code: 'location_retired' }).kind).toBe('refused');
    expect(classifyResponse(400, { code: 'validation_failed', errors: [] }).kind).toBe('refused');
    // An unreadable success is not proof of saving: retry the same intent.
    expect(classifyResponse(201, { nonsense: true }).kind).toBe('unavailable');
  });

  it('backs off from 2 s to a 1 min ceiling', () => {
    expect([1, 2, 3, 10].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 60_000]);
  });

  it('links a new scan only to an unanswered move of the same unit, account and station', async () => {
    const pending = await store.add(newMove(U1, C1));
    const { moves } = await store.list();
    expect(predecessorFor(moves, U1.id, LAB, STATION)?.clientMoveId).toBe(pending.clientMoveId);
    expect(predecessorFor(moves, U1.id, TECH, STATION)).toBeNull();
    expect(predecessorFor(moves, U1.id, LAB, crypto.randomUUID())).toBeNull();
    expect(predecessorFor(moves, U2.id, LAB, STATION)).toBeNull();
    await store.update(pending.clientMoveId, { state: 'conflict' });
    expect(predecessorFor((await store.list()).moves, U1.id, LAB, STATION)).toBeNull();
  });

  it('formats scan times with their offset', () => {
    expect(isoWithOffset(new Date('2026-10-27T15:15:00Z'))).toMatch(
      /^2026-10-27T\d{2}:15:00\.000[+-]\d{2}:\d{2}$/,
    );
  });
});

describe('batch duplicates (P20)', () => {
  const item = (readableId: string, destination = C2): BatchItem => ({
    key: readableId,
    kind: 'move',
    clientMoveId: `id-${readableId}`,
    readableId,
    unitId: readableId,
    destination,
  });

  it('ignores U1 again in a U1 → U2 → U1 batch, but not after a destination change or dismissal', () => {
    const items = [item('BKT-2026-000014'), item('BKT-2026-000015')];
    expect(inBatch(items, 'BKT-2026-000014', C2.id)).toBe(true);
    expect(inBatch(items, 'BKT-2026-000014', C1.id)).toBe(false);
    expect(inBatch(items, 'BKT-2026-000014', C2.id, new Set(['id-BKT-2026-000014']))).toBe(false);
  });
});
