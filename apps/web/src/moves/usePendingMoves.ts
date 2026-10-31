import { useEffect, useState } from 'react';
import { indexedDbMoveStore, type MoveStore, type QueuedMove } from './store';

// Moves scanned in this browser profile and not saved yet (MM-T81), for the inventory list's
// "Pending" marker. Read from the local queue only, so another device never sees them; re-read
// whenever a tab announces a queue change on the same BroadcastChannel as useMoveQueue.

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
  store: MoveStore = indexedDbMoveStore,
): Map<string, QueuedMove> {
  const [pending, setPending] = useState<Map<string, QueuedMove>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void store.list().then(
        ({ moves }) => {
          if (!cancelled) setPending(pendingMovesByUnit(moves, accountId));
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
