import {
  moveConflictResponseSchema,
  moveSavedResponseSchema,
  type MoveConflictResponse,
  type MoveRequest,
  type MoveSavedResponse,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import type { MoveStore, QueuedMove } from './store';

// Sending the move queue (MM-T28). The queue is drained in scan order, one request at a time, by
// one tab of the browser profile at a time (see useMoveQueue). Each intent is sent exactly as it
// was stored; the server's idempotency on clientMoveId makes a retry after a lost response safe.

/** What one delivery attempt told us. */
export type SendOutcome =
  | { kind: 'saved'; body: MoveSavedResponse }
  | { kind: 'conflict'; body: MoveConflictResponse }
  /** The earlier move of this unit hasn't been saved: hold this one. */
  | { kind: 'waiting'; message: string }
  /** Refused for good (validation, unknown unit/location, disposed, retired…): nothing recorded. */
  | { kind: 'refused'; code: string; message: string }
  /** Session gone: pause everything until the same account signs in again. */
  | { kind: 'unauthenticated' }
  /** This account may not move units: pause; choosing another person doesn't help. */
  | { kind: 'forbidden'; message: string }
  /** No answer, or a server error: the outcome is unknown, so retry the same intent later. */
  | { kind: 'unavailable' };

const SEND_TIMEOUT_MS = 15_000;

const REFUSED_MESSAGES: Record<string, string> = {
  storage_unit_disposed: 'This storage unit is disposed and can’t be moved.',
  location_retired: 'The destination was retired before this move synced. Scan another one.',
  storage_unit_not_found: 'This storage unit no longer exists.',
  location_not_found: 'The destination no longer exists.',
  idempotency_key_reused: 'This move’s ID was already used for a different move.',
  predecessor_invalid: 'This move is linked to an earlier move that doesn’t match it.',
  mover_required: 'Choose who is moving the units, then scan again.',
  unknown_mover: 'The person chosen as “Moved by” is no longer an active staff member.',
  mover_not_allowed: 'Only a shared LAB station names who moved a unit.',
  capture_account_mismatch: 'Scanned by another account; sign in as that account to send it.',
  validation_failed: 'Material Mule couldn’t read this move.',
};

/** Classifies one response (or its absence). Pure, so the rules are testable on their own. */
export function classifyResponse(status: number | null, body: unknown): SendOutcome {
  if (status === null || status >= 500) return { kind: 'unavailable' };
  if (status === 401) return { kind: 'unauthenticated' };
  const code =
    body && typeof body === 'object' && 'code' in body
      ? String((body as { code: unknown }).code)
      : '';
  const serverMessage =
    body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : null;
  if (status === 200 || status === 201) {
    const saved = moveSavedResponseSchema.safeParse(body);
    return saved.success ? { kind: 'saved', body: saved.data } : { kind: 'unavailable' };
  }
  if (status === 409 && code === 'location_conflict') {
    const conflict = moveConflictResponseSchema.safeParse(body);
    return conflict.success ? { kind: 'conflict', body: conflict.data } : { kind: 'unavailable' };
  }
  if (status === 409 && code === 'predecessor_not_applied') {
    return {
      kind: 'waiting',
      message: serverMessage ?? 'Waiting for the earlier move of this unit.',
    };
  }
  if (status === 403 && code !== 'capture_account_mismatch') {
    return {
      kind: 'forbidden',
      message: 'This account isn’t allowed to move storage units. The moves stay queued.',
    };
  }
  return {
    kind: 'refused',
    code: code || `http_${status}`,
    message: REFUSED_MESSAGES[code] ?? serverMessage ?? 'Material Mule refused this move.',
  };
}

export async function sendMove(request: MoveRequest): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await apiFetch(
      '/api/moves',
      {
        method: 'POST',
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
      // Keep the person on the Move screen: the queue pauses and offers Sign in instead.
      { reportUnauthenticated: false },
    );
  } catch {
    return { kind: 'unavailable' };
  }
  const body: unknown = await response.json().catch(() => null);
  return classifyResponse(response.status, body);
}

/** Why a drain stopped early; null when it reached the end of the queue. */
export type DrainStop = 'unavailable' | 'unauthenticated' | 'forbidden' | null;

export interface DrainResult {
  stop: DrainStop;
  /** Moves this drain settled (saved or conflict), for refreshing views. */
  settled: QueuedMove[];
}

/** Moves that still need sending for `accountId`, in scan order. Other accounts' are held. */
export function sendableMoves(moves: QueuedMove[], accountId: string): QueuedMove[] {
  return moves
    .filter(
      (move) =>
        move.request.captureContext.accountId === accountId &&
        (move.state === 'pending' || move.state === 'waiting'),
    )
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Sends this account's queued moves in scan order. A conflict, refusal or hold on one move holds
 * the later moves linked to it (same unit), never unrelated units. A lost connection, expired
 * session or missing permission stops the whole drain with everything still queued.
 */
export async function drainQueue(deps: {
  store: MoveStore;
  accountId: string;
  send: (request: MoveRequest) => Promise<SendOutcome>;
  onProgress?: (clientMoveId: string | null) => void;
}): Promise<DrainResult> {
  const { moves } = await deps.store.list();
  const byId = new Map(moves.map((move) => [move.clientMoveId, move]));
  const settled: QueuedMove[] = [];

  for (const move of sendableMoves(moves, deps.accountId)) {
    const previousId = move.request.previousClientMoveId;
    const previous = previousId ? byId.get(previousId) : undefined;
    if (previous && previous.state !== 'saved') {
      // Held: the earlier move of this unit hasn't saved (it waits, conflicted or was refused).
      const message =
        previous.state === 'conflict'
          ? `Waiting: the earlier move of ${move.unit.readableId} is in a location conflict.`
          : previous.state === 'pending'
            ? `Waiting for the earlier move of ${move.unit.readableId}.`
            : `Waiting: the earlier move of ${move.unit.readableId} needs attention.`;
      await hold(deps.store, byId, move, message);
      continue;
    }

    deps.onProgress?.(move.clientMoveId);
    const outcome = await deps.send(move.request);
    const attempts = move.attempts + 1;
    switch (outcome.kind) {
      case 'saved':
      case 'conflict': {
        const change =
          outcome.kind === 'saved'
            ? {
                state: 'saved' as const,
                message: null,
                result: {
                  movementEventId: outcome.body.movementEventId,
                  resultingVersion: outcome.body.resultingVersion,
                  savedAt: outcome.body.savedAt,
                },
              }
            : {
                state: 'conflict' as const,
                message: outcome.body.message,
                result: { conflictId: outcome.body.conflictId },
              };
        await deps.store.update(move.clientMoveId, { ...change, attempts });
        const next = { ...move, ...change, attempts };
        byId.set(move.clientMoveId, next);
        settled.push(next);
        break;
      }
      case 'waiting':
        await deps.store.update(move.clientMoveId, { attempts });
        await hold(deps.store, byId, { ...move, attempts }, outcome.message);
        break;
      case 'refused': {
        const change = { state: 'attention' as const, message: outcome.message, attempts };
        await deps.store.update(move.clientMoveId, change);
        byId.set(move.clientMoveId, { ...move, ...change });
        break;
      }
      case 'unauthenticated':
      case 'forbidden':
      case 'unavailable':
        // Outcome unknown or not allowed now: keep it exactly as it is and stop.
        await deps.store.update(move.clientMoveId, { attempts });
        deps.onProgress?.(null);
        return { stop: outcome.kind, settled };
    }
  }
  deps.onProgress?.(null);
  return { stop: null, settled };
}

async function hold(
  store: MoveStore,
  byId: Map<string, QueuedMove>,
  move: QueuedMove,
  message: string,
): Promise<void> {
  if (move.state !== 'waiting' || move.message !== message) {
    await store.update(move.clientMoveId, { state: 'waiting', message });
  }
  byId.set(move.clientMoveId, { ...move, state: 'waiting', message });
}

/**
 * For a new scan of `unitId` at this station: the latest move of the same unit by the same
 * account and station that hasn't been answered yet. The new move is linked to it (and shares its
 * base version), so the server applies them in order and never rebases onto a version it guessed.
 */
export function predecessorFor(
  moves: QueuedMove[],
  unitId: string,
  accountId: string,
  station: string,
): QueuedMove | null {
  const candidates = moves.filter(
    (move) =>
      move.unit.id === unitId &&
      move.request.captureContext.accountId === accountId &&
      move.request.captureContext.stationId === station &&
      (move.state === 'pending' || move.state === 'waiting'),
  );
  return candidates.sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** Retry delay after an unanswered attempt: 2 s doubling to 1 min. */
export function retryDelay(failures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
}
