import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import type { ReceiptDraft } from './draft';
import { authorizeDraftDelete, registerDraft } from './drafts/ownership';
import { withData, type DraftStatus, type DraftStep, type StoredDraft } from './drafts/record';
import {
  indexedDbDraftStore,
  toStorageError,
  trackDraftWrite,
  type DraftStore,
} from './drafts/store';

/** Autosave runs this long after the last change (MM-T11: "about 1 s"). */
export const AUTOSAVE_DELAY_MS = 1000;

export type SaveState =
  { kind: 'unsaved' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };

/**
 * Server calls for draft ownership (STRATA-108). Injected so tests can stand in; `null` turns
 * registration off (a deletion then still asks the default server).
 */
export interface DraftRegistryClient {
  register: typeof registerDraft;
  authorizeDelete: typeof authorizeDraftDelete;
}

export const httpDraftRegistry: DraftRegistryClient = {
  register: registerDraft,
  authorizeDelete: authorizeDraftDelete,
};

/**
 * The receiving draft as one object (MM-T10), saved on this workstation (MM-T11): about 1 s
 * after each change, and at once on step changes, when a field loses focus, when the page is
 * hidden or closed, and when the wizard unmounts. Writes run one after another, so an older
 * snapshot never overwrites a newer one. `saveState` reports only what storage confirmed: a
 * failed write shows as an error until a later write succeeds, never as saved.
 *
 * STRATA-108: after the first stored save the draft's ownership is registered on the server
 * (who started it: the account, or on a LAB station the picked person), best effort and retried
 * after later saves or when the connection returns. Only metadata is sent, never the draft.
 * `discard()` deletes it as a person does: the server authorizes first. `remove()` stays the local
 * removal used once a receipt is confirmed.
 */
export function useReceiptDraft(
  initial: StoredDraft,
  {
    accountId,
    persisted,
    registry = httpDraftRegistry,
  }: {
    accountId: string;
    persisted: boolean;
    /** Optional (STRATA-108): ownership calls; `null` skips registration. */
    registry?: DraftRegistryClient | null;
  },
  store: DraftStore = indexedDbDraftStore,
) {
  const station = useOptionalRecordingPerson();
  const pickedId = station?.isStation ? (station.person?.id ?? null) : null;
  const picked = useRef(pickedId);
  useEffect(() => {
    picked.current = pickedId;
  });
  const [record, setRecord] = useState<StoredDraft>(initial);
  const [saveState, setSaveState] = useState<SaveState>(
    persisted ? { kind: 'saved', at: initial.lastSavedAt } : { kind: 'unsaved' },
  );
  // The latest record, updated synchronously, so edits apply in order and flushes see them.
  const latest = useRef(initial);
  const dirty = useRef(false);
  /** Set once the draft is deleted (confirmed or discarded): nothing may write it back. */
  const closed = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** A registration request in flight, or one the server refused (another account's ID). */
  const registering = useRef<'idle' | 'busy' | 'refused'>('idle');
  const afterSave = useRef<() => void>(() => undefined);

  /** Writes the latest record now if it has unsaved changes. Resolves true once it's stored. */
  const flush = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (closed.current || !dirty.current) {
      return queue.current.then(() => !dirty.current && !closed.current);
    }
    dirty.current = false;
    const snapshot: StoredDraft = { ...latest.current, lastSavedAt: new Date().toISOString() };
    const write = queue.current.then(() =>
      store.put(snapshot).then(
        () => {
          if (!closed.current) setSaveState({ kind: 'saved', at: snapshot.lastSavedAt });
          afterSave.current();
          return true;
        },
        (error: unknown) => {
          // Try again with the next change or flush; until then the indicator says it failed.
          dirty.current = true;
          setSaveState({ kind: 'error', message: toStorageError(error).message });
          return false;
        },
      ),
    );
    queue.current = trackDraftWrite(write);
    return write;
  }, [store]);

  const commit = useCallback(
    (next: StoredDraft) => {
      if (closed.current) return;
      latest.current = next;
      setRecord(next);
      dirty.current = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  /** Functional update, so concurrent edits (e.g. a project created inline) never clobber others. */
  const update = useCallback(
    (recipe: (current: ReceiptDraft) => ReceiptDraft) =>
      commit(withData(latest.current, recipe(latest.current.data), accountId)),
    [accountId, commit],
  );

  const setStep = useCallback(
    (step: DraftStep) => {
      if (latest.current.step !== step) commit({ ...latest.current, step });
      return flush();
    },
    [commit, flush],
  );

  const setStatus = useCallback(
    (status: DraftStatus) => {
      if (latest.current.status !== status) commit({ ...latest.current, status });
      return flush();
    },
    [commit, flush],
  );

  /**
   * Registers the draft's ownership once it is stored (best effort). A LAB draft records the
   * person picked at its first save as its starter; nothing later changes it.
   */
  const register = useCallback(() => {
    const current = latest.current;
    if (!registry || closed.current || registering.current !== 'idle') return;
    if (current.legacy || current.registeredAt) return;
    const lab = current.owner.type === 'lab';
    const personUserId = lab ? (current.starter?.userId ?? picked.current) : undefined;
    if (lab && !personUserId) return;
    registering.current = 'busy';
    void registry.register(current.draftId, personUserId ?? undefined).then((result) => {
      registering.current = result === 'refused' ? 'refused' : 'idle';
      if (!result || result === 'refused' || closed.current) return;
      const now = latest.current;
      if (now.draftId !== result.draftId) return;
      latest.current = {
        ...now,
        starter: result.starter ?? now.starter,
        registeredAt: new Date().toISOString(),
      };
      setRecord(latest.current);
      dirty.current = true;
      void flush();
    });
  }, [registry, flush]);

  useEffect(() => {
    afterSave.current = register;
  });

  useEffect(() => {
    const retry = () => register();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [register]);

  /** Deletes the draft from this computer, after any write already queued. */
  const remove = useCallback((): Promise<void> => {
    closed.current = true;
    window.clearTimeout(timer.current);
    const draftId = latest.current.draftId;
    const removal = queue.current.then(() => store.remove(draftId));
    queue.current = trackDraftWrite(removal.catch(() => undefined));
    return removal;
  }, [store]);

  useEffect(() => {
    const onPageHide = () => void flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      void flush();
    };
  }, [flush]);

  /**
   * Deletes the draft as a person does (STRATA-108): the server checks that this is its starter
   * (on LAB, with the starter picked) or a Lab Manager, and records it; only then is the local
   * copy removed. Throws DraftDeleteError when refused or offline, leaving the draft as it was.
   */
  const discard = useCallback(async (): Promise<void> => {
    await queue.current;
    await (registry ?? httpDraftRegistry).authorizeDelete(latest.current.draftId, picked.current);
    await remove();
  }, [registry, remove]);

  return {
    draft: record.data,
    record,
    saveState,
    update,
    flush,
    setStep,
    setStatus,
    remove,
    discard,
  };
}
