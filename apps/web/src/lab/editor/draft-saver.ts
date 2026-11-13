import type { LabProgram, LabProgramReview } from '@materialmule/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import { fetchProgram, fetchReview, saveProgram, type WriteResult } from '../api';
import { linesFromProgram, toInput } from '../line-draft';
import type { EditAction, ProgramEditState } from './program-state';

// Saves as you go (STRATA-86): every edit is sent with the draft's version a moment after the
// person stops, one save at a time. After each save the server's review is loaded, so each line
// shows the storage units it covers and the problems only the server knows. A version conflict
// stops saving until the person reloads: nothing they typed is overwritten without their say.

const SAVE_DELAY_MS = 700;

export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: Date }
  | { state: 'failed'; message: string };

export type DraftConflict =
  /** Saved elsewhere since this page loaded ("This program changed. Reload it to continue."). */
  | { kind: 'changed'; current: LabProgram | null }
  /** Submitted or discarded elsewhere. */
  | { kind: 'gone' };

interface Snapshot {
  state: ProgramEditState;
  personId: string | null;
}

const targetOf = ({ state, personId }: Snapshot) => `${state.revision}|${personId ?? ''}`;

function failedText(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  switch (result.kind) {
    case 'invalid':
      return result.errors.length > 0
        ? `Not saved: ${result.errors.map((error) => error.message).join(' ')}`
        : 'Not saved: some details need attention.';
    case 'forbidden':
      return 'Not saved: you don’t have permission to change this draft.';
    case 'unauthenticated':
      return 'Not saved: your session ended. Sign in again; this page keeps what you typed.';
    case 'network':
      return 'Not saved: couldn’t reach Material Mule.';
    default:
      return 'Not saved: something went wrong.';
  }
}

export interface DraftSaver {
  status: SaveStatus;
  version: number;
  conflict: DraftConflict | null;
  /** The latest review and whether it was made from what is on screen now. */
  review: LabProgramReview | null;
  reviewCurrent: boolean;
  /** Saves anything pending now; true once the server holds exactly what is on screen. */
  flush(): Promise<boolean>;
  /** Loads the review for what is saved; null if it couldn't load. */
  loadReview(): Promise<LabProgramReview | null>;
  setReview(review: LabProgramReview): void;
  /** Reload: take the newer saved version (from the conflict, or fetched now). */
  reload(): Promise<void>;
  retry(): void;
  /** A submission found the draft changed: stop saving until Reload. */
  markConflict(current: LabProgram | null): void;
}

export function useDraftSaver({
  programId,
  initialVersion,
  state,
  personId,
  sendPerson,
  dispatch,
}: {
  programId: string | null;
  initialVersion: number;
  state: ProgramEditState;
  personId: string | null;
  /** A LAB station names Requested by on every save (attribution only). */
  sendPerson: boolean;
  dispatch: Dispatch<EditAction>;
}): DraftSaver {
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });
  const [version, setVersion] = useState(initialVersion);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [stored, setStored] = useState<{ review: LabProgramReview; target: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef<Snapshot>({ state, personId });
  const versionRef = useRef(initialVersion);
  const savedTarget = useRef(targetOf({ state, personId }));
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const blocked = useRef(false);
  useLayoutEffect(() => {
    latest.current = { state, personId };
  });
  const target = targetOf({ state, personId });

  const loadReview = useCallback(async (): Promise<LabProgramReview | null> => {
    if (!programId) return null;
    const forTarget = savedTarget.current;
    try {
      const review = await fetchReview(programId);
      setStored({ review, target: forTarget });
      return review;
    } catch {
      return null;
    }
  }, [programId]);

  const runSave = useCallback(async (): Promise<boolean> => {
    if (!programId || blocked.current) return false;
    const snapshot = latest.current;
    const wanted = targetOf(snapshot);
    if (wanted === savedTarget.current) return true;
    setStatus({ state: 'saving' });
    const result = await saveProgram(programId, {
      version: versionRef.current,
      notes: snapshot.state.notes.trim() || null,
      lines: snapshot.state.lines.map(toInput),
      ...(sendPerson && snapshot.personId ? { requestedByUserId: snapshot.personId } : {}),
    });
    if (!result.ok) {
      if (result.kind === 'conflict') {
        blocked.current = true;
        setStatus({ state: 'idle' });
        setConflict(
          result.code === 'version_conflict'
            ? { kind: 'changed', current: result.current ?? null }
            : { kind: 'gone' },
        );
        return false;
      }
      if (result.kind === 'not_found') {
        blocked.current = true;
        setStatus({ state: 'idle' });
        setConflict({ kind: 'gone' });
        return false;
      }
      setStatus({ state: 'failed', message: failedText(result) });
      return false;
    }
    const saved = result.value;
    versionRef.current = saved.version;
    setVersion(saved.version);
    savedTarget.current = wanted;
    // Keep the client keys stable but learn the server's line IDs (same order as sent).
    const ids: Record<string, string> = {};
    snapshot.state.lines.forEach((line, i) => {
      const id = saved.lines[i]?.id;
      if (id && line.id !== id) ids[line.key] = id;
    });
    if (Object.keys(ids).length > 0) dispatch({ type: 'learn-ids', ids });
    setStatus({ state: 'saved', at: new Date() });
    await loadReview();
    return targetOf(latest.current) === wanted;
  }, [programId, sendPerson, dispatch, loadReview]);

  const queueSave = useCallback((): Promise<boolean> => {
    chain.current = chain.current.then(runSave, runSave);
    return chain.current;
  }, [runSave]);

  useEffect(() => {
    if (!programId || conflict || target === savedTarget.current) return;
    const timer = window.setTimeout(() => void queueSave(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [programId, conflict, target, queueSave, attempt]);

  // Leaving the page still sends what was typed in the last moment.
  useEffect(
    () => () => {
      if (targetOf(latest.current) !== savedTarget.current) void queueSave();
    },
    [queueSave],
  );

  const flush = useCallback(async () => {
    if (targetOf(latest.current) === savedTarget.current) {
      await chain.current.catch(() => false);
      return !blocked.current;
    }
    return queueSave();
  }, [queueSave]);

  const reload = useCallback(async () => {
    if (!programId) return;
    let program = conflict?.kind === 'changed' ? conflict.current : null;
    if (!program) {
      try {
        program = await fetchProgram(programId);
      } catch {
        program = null;
      }
    }
    if (!program || program.status !== 'draft') {
      setConflict({ kind: 'gone' });
      return;
    }
    versionRef.current = program.version;
    setVersion(program.version);
    // The replace below is the next revision; it is what the server already holds.
    savedTarget.current = targetOf({
      state: { ...latest.current.state, revision: latest.current.state.revision + 1 },
      personId: latest.current.personId,
    });
    dispatch({ type: 'replace', notes: program.notes ?? '', lines: linesFromProgram(program) });
    blocked.current = false;
    setConflict(null);
    setStatus({ state: 'saved', at: new Date(program.updatedAt) });
    setStored(null);
    void loadReview();
  }, [programId, conflict, dispatch, loadReview]);

  return {
    status,
    version,
    conflict,
    review: stored?.review ?? null,
    reviewCurrent: stored !== null && stored.target === target && stored.review.version === version,
    flush,
    loadReview,
    setReview: (review) => setStored({ review, target }),
    reload,
    retry: () => setAttempt((n) => n + 1),
    markConflict: (current) => {
      blocked.current = true;
      setConflict({ kind: 'changed', current });
    },
  };
}
