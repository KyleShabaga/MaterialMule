import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_USER_PREFERENCES,
  LAB_TIME_ZONE,
  sidebarLayoutResponseSchema,
  sidebarLayoutVersionConflictSchema,
  userPreferencesResponseSchema,
  userPreferencesVersionConflictSchema,
  type UserPreferences,
  type UserPreferencesResponse,
} from '@materialmule/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';

// Settings › Preferences and Notifications (STRATA-29, STRATA-55, STRATA-101): one per-person
// store with one version (lane 1C, packages/shared/src/user-preferences.ts).
//   GET   /api/me/preferences   LAB gets the defaults with readOnly: true
//   PATCH /api/me/preferences   changed fields + the version last read; stale → 409 with current;
//                               LAB → 403
// The shared LAB account never saves anyone's preferences (STRATA-119): the hook sends nothing
// when `station` is set, and nothing when the server says the store is read-only.

export const PREFERENCES_PATH = '/api/me/preferences';

export const SAVE_FAILED_MESSAGE = 'That change wasn’t saved. Check the connection and try again.';
export const CONFLICT_MESSAGE = 'Someone changed this on another computer; showing the latest.';
export const READ_ONLY_MESSAGE = 'This account can’t save preferences.';

export type PatchResult =
  | { kind: 'saved'; response: UserPreferencesResponse }
  | { kind: 'conflict'; current: UserPreferencesResponse }
  | { kind: 'forbidden' }
  | { kind: 'failed' };

export async function fetchPreferences(): Promise<UserPreferencesResponse> {
  const response = await apiFetch(PREFERENCES_PATH);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return userPreferencesResponseSchema.parse(await response.json());
}

/** Sends only the changed fields, with the version last read. Never throws. */
export async function patchPreferences(
  change: Partial<UserPreferences>,
  version: number,
): Promise<PatchResult> {
  try {
    const response = await apiFetch(PREFERENCES_PATH, {
      method: 'PATCH',
      body: JSON.stringify({ ...change, version }),
    });
    if (response.ok) {
      return {
        kind: 'saved',
        response: userPreferencesResponseSchema.parse(await response.json()),
      };
    }
    if (response.status === 409) {
      const conflict = userPreferencesVersionConflictSchema.safeParse(
        await response.json().catch(() => null),
      );
      return conflict.success
        ? { kind: 'conflict', current: conflict.data.current }
        : { kind: 'failed' };
    }
    if (response.status === 403) return { kind: 'forbidden' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'error'; message: string }
  | { state: 'conflict'; message: string };

export interface PersonPreferences {
  load: 'loading' | 'error' | 'ready';
  /** What is on screen: the saved preferences with any change still being saved. */
  preferences: UserPreferences;
  /** Nothing can be changed (the shared LAB account, or the server said so). */
  readOnly: boolean;
  labTimeZone: string;
  status: SaveStatus;
  /**
   * Applies `change` at once and saves it in the background. Resolves with the preferences on
   * screen once the save settles (after a failure or a conflict, the saved values).
   */
  update(change: Partial<UserPreferences>): Promise<UserPreferences>;
  reload(): void;
}

type Overlay = Partial<Record<keyof UserPreferences, unknown>>;

/**
 * The person's preferences, read once. Each change shows at once (optimistic) and is saved in
 * order, one PATCH at a time, with the version last read. A failed save puts the saved value
 * back with a plain error; a 409 takes the server's current preferences and says so.
 *
 * `station`: the shared LAB account. It shows the defaults read-only and never asks or saves.
 */
export function usePersonPreferences({ station = false }: { station?: boolean } = {}) {
  const [confirmed, setConfirmed] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [overlay, setOverlay] = useState<Overlay>({});
  const [load, setLoad] = useState<PersonPreferences['load']>(station ? 'ready' : 'loading');
  const [readOnly, setReadOnly] = useState(station);
  const [labTimeZone, setLabTimeZone] = useState<string>(LAB_TIME_ZONE);
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });
  const [reloads, setReloads] = useState(0);

  const version = useRef(0);
  const readOnlyRef = useRef(station);
  const confirmedRef = useRef(confirmed);
  const overlayRef = useRef<Overlay>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setConfirmedBoth = useCallback((next: UserPreferences) => {
    confirmedRef.current = next;
    setConfirmed(next);
  }, []);
  const setOverlayBoth = useCallback((next: Overlay) => {
    overlayRef.current = next;
    setOverlay(next);
  }, []);

  useEffect(() => {
    if (station) return;
    let active = true;
    fetchPreferences().then(
      (data) => {
        if (!active) return;
        version.current = data.version;
        readOnlyRef.current = data.readOnly;
        setReadOnly(data.readOnly);
        setLabTimeZone(data.labTimeZone);
        setConfirmedBoth(data.preferences);
        setLoad('ready');
      },
      () => {
        if (active) setLoad('error');
      },
    );
    return () => {
      active = false;
    };
  }, [station, reloads, setConfirmedBoth]);

  /** Drops the keys of `sent` the person hasn't changed again since. */
  const settle = useCallback(
    (sent: Partial<UserPreferences>) => {
      const next: Overlay = { ...overlayRef.current };
      for (const [key, value] of Object.entries(sent)) {
        const k = key as keyof UserPreferences;
        if (Object.is(next[k], value)) delete next[k];
      }
      setOverlayBoth(next);
      return { ...confirmedRef.current, ...next } as UserPreferences;
    },
    [setOverlayBoth],
  );

  const update = useCallback(
    (change: Partial<UserPreferences>): Promise<UserPreferences> => {
      if (readOnlyRef.current)
        return Promise.resolve({
          ...confirmedRef.current,
          ...overlayRef.current,
        } as UserPreferences);
      setOverlayBoth({ ...overlayRef.current, ...change });
      setStatus({ state: 'saving' });
      pending.current += 1;
      const run = queue.current.then(async () => {
        const result = await patchPreferences(change, version.current);
        pending.current -= 1;
        if (!mounted.current) return { ...confirmedRef.current, ...change } as UserPreferences;
        switch (result.kind) {
          case 'saved':
            version.current = result.response.version;
            setConfirmedBoth(result.response.preferences);
            if (pending.current === 0) setStatus({ state: 'saved' });
            return settle(change);
          case 'conflict':
            version.current = result.current.version;
            setConfirmedBoth(result.current.preferences);
            setStatus({ state: 'conflict', message: CONFLICT_MESSAGE });
            return settle(change);
          case 'forbidden':
            readOnlyRef.current = true;
            setReadOnly(true);
            setStatus({ state: 'error', message: READ_ONLY_MESSAGE });
            return settle(change);
          default:
            setStatus({ state: 'error', message: SAVE_FAILED_MESSAGE });
            return settle(change);
        }
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [setConfirmedBoth, setOverlayBoth, settle],
  );

  const reload = useCallback(() => {
    setLoad('loading');
    setReloads((n) => n + 1);
  }, []);

  const value: PersonPreferences = {
    load,
    preferences: { ...confirmed, ...overlay } as UserPreferences,
    readOnly,
    labTimeZone,
    status,
    update,
    reload,
  };
  return value;
}

// ---- Reset sidebar layout (Settings › Preferences › Sidebar) ----

export const SIDEBAR_LAYOUT_PATH = '/api/me/sidebar-layout';

/**
 * Fired after the saved sidebar layout was reset here, so a shell that listens can reload it.
 * (The shell's layout hook lives in layout/sidebar-prefs.ts, which this lane doesn't change.)
 */
export const SIDEBAR_LAYOUT_RESET_EVENT = 'materialmule:sidebar-layout-reset';

/**
 * Puts the saved sidebar layout back to the default: reads the version, then saves the default
 * with it; a version conflict retries once with the newer version. Resolves true when saved.
 */
export async function resetSidebarLayout(): Promise<boolean> {
  try {
    const read = await apiFetch(SIDEBAR_LAYOUT_PATH);
    if (!read.ok) return false;
    let version = sidebarLayoutResponseSchema.parse(await read.json()).version;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await apiFetch(SIDEBAR_LAYOUT_PATH, {
        method: 'PUT',
        body: JSON.stringify({
          order: [...DEFAULT_SIDEBAR_LAYOUT.order],
          hidden: [...DEFAULT_SIDEBAR_LAYOUT.hidden],
          folded: [...DEFAULT_SIDEBAR_LAYOUT.folded],
          version,
        }),
      });
      if (response.ok) {
        window.dispatchEvent(new Event(SIDEBAR_LAYOUT_RESET_EVENT));
        return true;
      }
      if (response.status !== 409) return false;
      const conflict = sidebarLayoutVersionConflictSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!conflict.success) return false;
      version = conflict.data.current.version;
    }
    return false;
  } catch {
    return false;
  }
}
