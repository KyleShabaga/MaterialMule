import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReceiptDraft } from './draft';
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
 * The receiving draft as one object (MM-T10), saved on this workstation (MM-T11): about 1 s
 * after each change, and at once on step changes, when a field loses focus, when the page is
 * hidden or closed, and when the wizard unmounts. Writes run one after another, so an older
 * snapshot never overwrites a newer one. `saveState` reports only what storage confirmed: a
 * failed write shows as an error until a later write succeeds, never as saved.
 */
export function useReceiptDraft(
  initial: StoredDraft,
  { accountId, persisted }: { accountId: string; persisted: boolean },
  store: DraftStore = indexedDbDraftStore,
) {
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

  return { draft: record.data, record, saveState, update, flush, setStep, setStatus, remove };
}
