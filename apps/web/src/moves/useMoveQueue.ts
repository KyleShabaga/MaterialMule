import type { MoveRequest } from '@materialmule/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drainQueue, retryDelay, sendMove, type DrainStop, type SendOutcome } from './queue';
import {
  indexedDbMoveStore,
  toStorageError,
  type MoveStore,
  type NewMove,
  type QueuedMove,
} from './store';

// The move queue as React state (MM-T28). Tabs of one browser profile share the IndexedDB queue;
// a Web Lock lets only one of them drain at a time, so reopening a second tab never sends a move
// twice or out of order (the server's idempotency would absorb it anyway). A BroadcastChannel
// tells the other tabs to re-read the queue after any change. Nothing here outlives the page:
// with no service worker, queued moves wait in IndexedDB until the next visit.

const CHANNEL = 'materialmule-moves';
const LOCK = 'materialmule-move-drain';

export type QueueStatus =
  | { kind: 'idle' }
  | { kind: 'syncing'; clientMoveId: string | null }
  | { kind: 'offline'; retryInMs: number }
  | { kind: 'signin' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'storage'; message: string };

export interface MoveQueue {
  /** Every move stored in this profile, oldest first (all accounts; filter before showing). */
  moves: QueuedMove[];
  /** Records written by a newer Material Mule; kept and never sent. */
  unreadable: number;
  loaded: boolean;
  status: QueueStatus;
  /** Stores a new intent durably, then starts sending. Rejects with a storage error. */
  enqueue: (move: NewMove) => Promise<QueuedMove>;
  /** Clears a held or refused intent that the server never recorded. */
  dismiss: (clientMoveId: string) => Promise<void>;
  syncNow: () => void;
}

interface Options {
  accountId: string;
  store?: MoveStore;
  send?: (request: MoveRequest) => Promise<SendOutcome>;
  /** After a move saves or conflicts, e.g. to refresh cached units. */
  onSettled?: (moves: QueuedMove[]) => void;
}

/** Runs `work` while holding the profile-wide drain lock; false if another tab holds it. */
async function withDrainLock(work: () => Promise<void>): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) {
    await work();
    return true;
  }
  return locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await work();
    return true;
  });
}

export function useMoveQueue({
  accountId,
  store = indexedDbMoveStore,
  send = sendMove,
  onSettled,
}: Options): MoveQueue {
  const [moves, setMoves] = useState<QueuedMove[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<QueueStatus>({ kind: 'idle' });
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const channel = useRef<BroadcastChannel | null>(null);
  const draining = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  const reload = useCallback(async () => {
    try {
      const list = await store.list();
      if (!mounted.current) return;
      setMoves(list.moves);
      setUnreadable(list.unreadable);
      setLoaded(true);
    } catch (error) {
      if (mounted.current) setStatus({ kind: 'storage', message: toStorageError(error).message });
    }
  }, [store]);

  // The retry timer calls the latest drain without drain referring to itself.
  const drainRef = useRef<() => Promise<void>>(async () => undefined);

  const announce = useCallback(() => {
    channel.current?.postMessage('changed');
  }, []);

  const drain = useCallback(async () => {
    if (draining.current) {
      again.current = true;
      return;
    }
    draining.current = true;
    clearTimeout(retryTimer.current);
    try {
      // Assigned inside the lock callback, so TypeScript can't follow it as a plain let.
      const last: { stop: DrainStop } = { stop: null };
      const ran = await withDrainLock(async () => {
        do {
          again.current = false;
          const result = await drainQueue({
            store,
            accountId,
            send,
            onProgress: (clientMoveId) => {
              if (mounted.current && clientMoveId) setStatus({ kind: 'syncing', clientMoveId });
              void reload();
            },
          });
          last.stop = result.stop;
          if (result.settled.length > 0) {
            onSettledRef.current?.(result.settled);
            announce();
          }
        } while (again.current && last.stop === null);
      });
      if (!mounted.current) return;
      await reload();
      if (!ran) {
        // Another tab is sending; it re-reads the queue when told something changed.
        setStatus({ kind: 'idle' });
        return;
      }
      switch (last.stop) {
        case null:
          failures.current = 0;
          setStatus({ kind: 'idle' });
          break;
        case 'unavailable': {
          failures.current += 1;
          const wait = retryDelay(failures.current);
          setStatus({ kind: 'offline', retryInMs: wait });
          retryTimer.current = setTimeout(() => void drainRef.current(), wait);
          break;
        }
        case 'unauthenticated':
          setStatus({ kind: 'signin' });
          break;
        case 'forbidden':
          setStatus({
            kind: 'forbidden',
            message: 'This account isn’t allowed to move storage units. The moves stay queued.',
          });
          break;
      }
    } catch (error) {
      if (mounted.current) setStatus({ kind: 'storage', message: toStorageError(error).message });
    } finally {
      draining.current = false;
    }
  }, [accountId, announce, reload, send, store]);
  useEffect(() => {
    drainRef.current = drain;
  }, [drain]);

  useEffect(() => {
    mounted.current = true;
    // Load and send once the page is up (a callback, not during the effect itself).
    queueMicrotask(() => void reload().then(() => drain()));
    const onOnline = () => {
      failures.current = 0;
      void drain();
    };
    window.addEventListener('online', onOnline);
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = () => {
        void reload().then(() => drain());
      };
    }
    return () => {
      mounted.current = false;
      clearTimeout(retryTimer.current);
      window.removeEventListener('online', onOnline);
      channel.current?.close();
      channel.current = null;
    };
  }, [drain, reload]);

  const enqueue = useCallback(
    async (move: NewMove) => {
      // Durable first: if this throws, nothing is shown as Pending and nothing is sent.
      const stored = await store.add(move);
      await reload();
      announce();
      void drain();
      return stored;
    },
    [announce, drain, reload, store],
  );

  const dismiss = useCallback(
    async (clientMoveId: string) => {
      await store.update(clientMoveId, { state: 'dismissed' });
      await reload();
      announce();
    },
    [announce, reload, store],
  );

  const syncNow = useCallback(() => {
    failures.current = 0;
    void drain();
  }, [drain]);

  return useMemo(
    () => ({ moves, unreadable, loaded, status, enqueue, dismiss, syncNow }),
    [moves, unreadable, loaded, status, enqueue, dismiss, syncNow],
  );
}
