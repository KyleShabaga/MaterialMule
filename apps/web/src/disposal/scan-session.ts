import { normalizeStorageUnitCode, type DisposalScanIntent } from '@materialmule/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BulkResult } from '@/components/strata/bulk-confirm-dialog';
import {
  checkScans as checkScansApi,
  recordScans as recordScansApi,
  type ScanCall,
} from './scan-api';
import { indexedDbScanStore, toStorageError, type QueuedScan, type ScanStore } from './scan-store';

// The Disposal scan-out session (STRATA-92) as React state. Scans are intents stored on this
// computer first; online, each is checked by the server at once ("approved", "on hold"…); offline
// it waits as "Not disposed yet · needs online check" and is checked when the connection returns.
// Nothing is ever recorded automatically: recording happens only from `record`, which the page
// calls after the person confirmed the exact ID list (Kyle's decision STRATA-112, 2026-11-13).
// A recording that got no answer stays "uncertain" and is checked again (the server answers
// "recorded" with the first outcome when it did commit), so a unit is never shown as disposed
// before the server says so, and is never recorded twice.

export type ScanProblem =
  | { kind: 'signin' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

export type AddResult = 'added' | 'repeat' | 'failed';

export interface DisposalScanSession {
  /** This account's scans on this computer, oldest first. */
  scans: QueuedScan[];
  /** Scans another account took on this computer: kept, never sent from this sign-in. */
  otherAccounts: number;
  /** Records written by a newer Material Mule; kept and never sent. */
  unreadable: number;
  loaded: boolean;
  checking: boolean;
  problem: ScanProblem | null;
  add: (code: string) => Promise<AddResult>;
  /** Removes a scan the server never recorded; an uncertain one can't be removed. */
  remove: (intentId: string) => Promise<void>;
  /** Checks every queued or uncertain scan online now. */
  checkNow: () => void;
  /** Records the approved scans; call only after the person confirmed the exact list. */
  record: (intentIds: string[]) => Promise<BulkResult>;
  /** Clears finished and flagged scans (never an unanswered one) for the next round. */
  clearFinished: () => Promise<void>;
}

interface Options {
  account: { id: string; name: string };
  online: boolean;
  allowed: boolean;
  store?: ScanStore;
  check?: typeof checkScansApi;
  recordCall?: typeof recordScansApi;
}

const toIntent = (scan: QueuedScan): DisposalScanIntent => ({
  intentId: scan.intentId,
  code: scan.code,
  scannedByUserId: scan.account.id,
  scannedAt: scan.scannedAt,
});

function problemOf(call: ScanCall<unknown>): ScanProblem | null {
  switch (call.kind) {
    case 'ok':
      return null;
    case 'unauthenticated':
      return { kind: 'signin' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'invalid':
      return { kind: 'invalid', message: call.message };
    default:
      return { kind: 'unavailable' };
  }
}

export function useDisposalScanSession({
  account,
  online,
  allowed,
  store = indexedDbScanStore,
  check = checkScansApi,
  recordCall = recordScansApi,
}: Options): DisposalScanSession {
  const [all, setAll] = useState<QueuedScan[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<ScanProblem | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const again = useRef(false);
  const state = useRef({ online, allowed, accountId: account.id });
  useEffect(() => {
    state.current = { online, allowed, accountId: account.id };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await store.list();
      if (!mounted.current) return list.scans;
      setAll(list.scans);
      setUnreadable(list.unreadable);
      setLoaded(true);
      return list.scans;
    } catch (error) {
      if (mounted.current) {
        setProblem({ kind: 'storage', message: toStorageError(error).message });
        setLoaded(true);
      }
      return [];
    }
  }, [store]);

  const checkPending = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const { online: isOnline, allowed: may, accountId } = state.current;
        if (!isOnline || !may) return;
        const scans = await reload();
        const pending = scans.filter(
          (scan) =>
            scan.account.id === accountId &&
            (scan.state === 'queued' || scan.state === 'uncertain'),
        );
        if (pending.length === 0) {
          if (mounted.current) setProblem((p) => (p?.kind === 'storage' ? p : null));
          continue;
        }
        if (mounted.current) setChecking(true);
        const answer = await check(pending.map(toIntent));
        if (answer.kind !== 'ok') {
          if (mounted.current) setProblem(problemOf(answer));
          continue;
        }
        const checkedAt = new Date().toISOString();
        for (const result of answer.body.results) {
          await (result.status === 'recorded'
            ? store.update(result.intentId, {
                state: 'done',
                check: result,
                checkedAt,
                outcome: result.recorded,
              })
            : store.update(result.intentId, { state: 'checked', check: result, checkedAt }));
        }
        if (mounted.current) setProblem(null);
        await reload();
      } while (again.current);
    } catch (error) {
      if (mounted.current) setProblem({ kind: 'storage', message: toStorageError(error).message });
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [check, reload, store]);

  // On load, and whenever the connection returns: check what waits.
  useEffect(() => {
    // A callback, not during the effect itself.
    queueMicrotask(() => {
      void reload().then(() => {
        if (online && allowed) void checkPending();
      });
    });
  }, [online, allowed, reload, checkPending]);

  const scans = all.filter((scan) => scan.account.id === account.id);

  const add = useCallback(
    async (raw: string): Promise<AddResult> => {
      const code = normalizeStorageUnitCode(raw);
      if (!code) return 'failed';
      const current = await reload();
      if (
        current.some(
          (scan) =>
            scan.account.id === account.id &&
            scan.code === code &&
            !(scan.state === 'done' && scan.outcome?.result !== 'disposed'),
        )
      ) {
        return 'repeat';
      }
      try {
        await store.add({
          intentId: crypto.randomUUID(),
          code,
          scannedAt: new Date().toISOString(),
          account,
        });
      } catch (error) {
        if (mounted.current)
          setProblem({ kind: 'storage', message: toStorageError(error).message });
        return 'failed';
      }
      await reload();
      void checkPending();
      return 'added';
    },
    [account, checkPending, reload, store],
  );

  const remove = useCallback(
    async (intentId: string) => {
      const scan = all.find((s) => s.intentId === intentId);
      if (!scan || scan.state === 'uncertain') return;
      await store.remove([intentId]);
      await reload();
    },
    [all, reload, store],
  );

  const record = useCallback(
    async (intentIds: string[]): Promise<BulkResult> => {
      const chosen = (await reload()).filter(
        (scan) =>
          intentIds.includes(scan.intentId) &&
          scan.account.id === account.id &&
          scan.state === 'checked' &&
          scan.check?.status === 'approved',
      );
      if (chosen.length === 0) throw new Error('Nothing approved is waiting to be recorded.');
      // Durably "uncertain" before sending: if no answer comes, it is checked, never re-sent blind.
      for (const scan of chosen) await store.update(scan.intentId, { state: 'uncertain' });
      await reload();
      const answer = await recordCall(chosen.map(toIntent));
      if (answer.kind !== 'ok') {
        if (mounted.current) setProblem(problemOf(answer));
        if (answer.kind === 'invalid' || answer.kind === 'forbidden') {
          // Refused before anything was done: back to checked.
          for (const scan of chosen) await store.update(scan.intentId, { state: 'checked' });
          await reload();
          throw new Error(
            answer.kind === 'forbidden'
              ? 'This sign-in can’t record disposal. Nothing was recorded.'
              : `${answer.message} Nothing was recorded.`,
          );
        }
        await reload();
        throw new Error(
          answer.kind === 'unauthenticated'
            ? 'Your session ended. Sign in again: these scans stay on this computer and are checked before anything else.'
            : 'Material Mule didn’t answer. Nothing is shown as disposed: these scans stay on this computer and are checked again when it answers.',
        );
      }
      const succeeded: string[] = [];
      const failed: BulkResult['failed'] = [];
      for (const result of answer.body.results) {
        await store.update(result.intentId, { state: 'done', outcome: result.outcome });
        const id = result.outcome.readableId ?? result.code;
        if (result.outcome.result === 'disposed') succeeded.push(id);
        else failed.push({ id, reason: result.outcome.message });
      }
      if (mounted.current) setProblem(null);
      await reload();
      return { succeeded, failed };
    },
    [account.id, recordCall, reload, store],
  );

  const clearFinished = useCallback(async () => {
    const finished = (await reload()).filter(
      (scan) =>
        scan.account.id === account.id &&
        (scan.state === 'done' || (scan.state === 'checked' && scan.check?.status !== 'approved')),
    );
    await store.remove(finished.map((scan) => scan.intentId));
    await reload();
  }, [account.id, reload, store]);

  return {
    scans,
    otherAccounts: all.length - scans.length,
    unreadable,
    loaded,
    checking,
    problem,
    add,
    remove,
    checkNow: () => void checkPending(),
    record,
    clearFinished,
  };
}
