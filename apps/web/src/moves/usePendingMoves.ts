import { useEffect, useRef, useState } from 'react';
import { indexedDbMoveStore, type MoveStore, type QueuedMove } from './store';

// Moves scanned in this browser profile and not saved yet (MM-T81), for the inventory list's
// "Pending" marker. Read from the local queue only, so another device never sees them; re-read
// whenever a tab announces a queue change on the same BroadcastChannel as useMoveQueue.
//
// Review fix (#107): a change that only adds or updates a Pending marker needs nothing from the
// server. When a move this page was showing as Pending leaves the queue's pending states (saved,
// refused with a conflict, needs attention, dismissed), the server's rows changed too, so
// `onSettled` is called and the page reloads what it shows, keeping its filters and page.

const CHANNEL = 'materialmule-moves';

/** The latest pending or waiting move per storage unit ID, for `accountId`'s scans only. */
export function pendingMovesByUnit(
  moves: QueuedMove[],
  accountId: string,
): Map<string, QueuedMove> {
  const byUnit = new Map<string, QueuedMove>();
  for (const move of moves) {
    if (move.request.captureContext.accountId !== accountId) continue;
    if (move.state !== 'pending' && move.state !== 'waiting') continue;
    // Moves are listed in scan order, so the last one wins.
    byUnit.set(move.unit.id, move);
  }
  return byUnit;
}

export function usePendingMoves(
  accountId: string,
  { store = indexedDbMoveStore, onSettled }: { store?: MoveStore; onSettled?: () => void } = {},
): Map<string, QueuedMove> {
  const [pending, setPending] = useState<Map<string, QueuedMove>>(() => new Map());
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });
  useEffect(() => {
    let cancelled = false;
    // This account's moves at the last read: still pending, and already settled (null before
    // the first read, whose settled moves the page's own load already reflects).
    let wasPending = new Set<string>();
    let wasSettled: Set<string> | null = null;
    const reload = () => {
      void store.list().then(
        ({ moves }) => {
          if (cancelled) return;
          const own = moves.filter((move) => move.request.captureContext.accountId === accountId);
          const isPending = (move: QueuedMove) =>
            move.state === 'pending' || move.state === 'waiting';
          const pendingIds = new Set(own.filter(isPending).map((move) => move.clientMoveId));
          const settledIds = new Set(
            own.filter((move) => !isPending(move)).map((move) => move.clientMoveId),
          );
          // A move settled since the last read, even one queued and sent between two reads.
          const before = wasSettled;
          const settled =
            before !== null &&
            ([...settledIds].some((id) => !before.has(id)) ||
              [...wasPending].some((id) => !pendingIds.has(id)));
          wasPending = pendingIds;
          wasSettled = settledIds;
          setPending(pendingMovesByUnit(moves, accountId));
          if (settled) onSettledRef.current?.();
        },
        // Storage unavailable (private window, blocked): no marker, the saved location stands.
        () => {
          if (!cancelled) setPending(new Map());
        },
      );
    };
    reload();
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    if (channel) channel.onmessage = reload;
    return () => {
      cancelled = true;
      channel?.close();
    };
  }, [accountId, store]);
  return pending;
}
