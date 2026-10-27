import type { DraftAutoDelete } from './auto-delete';

// Hands the draft clean-up result from the run that deleted drafts to the Receive samples page
// that shows it (MM-T61). A run can finish after its page has gone (StrictMode's throw-away
// mount, or the user navigating away mid-run); the next Receive samples page then shows the
// notice. Kept in this tab's memory only, keyed by the signed-in account, and handed out once.
// Signing out reloads the page (SessionProvider), which clears it, so another person signing in
// on this browser never sees it either.

export interface CleanupResult {
  /** The setting as loaded for this run, or null when it couldn't be loaded. */
  autoDelete: DraftAutoDelete | null;
  /** How many drafts this run deleted. */
  deleted: number;
}

interface Pending {
  deleted: number;
  afterDays: number;
}

const running = new Map<string, Promise<CleanupResult>>();
const pending = new Map<string, Pending>();

/**
 * Runs the clean-up for this account unless a run is already in progress, which is joined
 * instead, so a remount mid-run neither deletes twice nor loses the count.
 */
export function runDraftCleanup(
  accountId: string,
  cleanUp: () => Promise<CleanupResult>,
): Promise<CleanupResult> {
  let run = running.get(accountId);
  if (!run) {
    run = cleanUp()
      .then((result) => {
        if (result.deleted > 0 && result.autoDelete) {
          const before = pending.get(accountId)?.deleted ?? 0;
          pending.set(accountId, {
            deleted: before + result.deleted,
            afterDays: result.autoDelete.afterDays,
          });
        }
        return result;
      })
      .finally(() => running.delete(accountId));
    running.set(accountId, run);
  }
  return run;
}

/** The clean-up result not yet shown to this account, removed as it is read. */
export function takeDraftCleanupNotice(accountId: string): Pending | null {
  const result = pending.get(accountId) ?? null;
  pending.delete(accountId);
  return result;
}

/** Tests only: forget every run and notice. */
export function resetDraftCleanupForTests() {
  running.clear();
  pending.clear();
}
