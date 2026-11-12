import {
  DEFAULT_SIDEBAR_LAYOUT,
  normalizeSidebarLayout,
  sidebarLayoutResponseSchema,
  sidebarLayoutVersionConflictSchema,
  sidebarRecordListSchema,
  type SidebarLayout,
  type SidebarLayoutResponse,
  type SidebarRecord,
  type SidebarRecordKind,
  type SidebarSectionId,
} from '@materialmule/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';

// Strata sidebar layout (DESIGN.md › Sidebar; STRATA-11, 38, 39, 40, 41, 42): which sections show
// and in what order, which are folded, and the person's Pinned and Recent records.
//
// Saved per person on the server (lane 1C, packages/shared/src/sidebar.ts):
//   GET /api/me/sidebar-layout            (LAB: ?personId= of the picked person, read-only)
//   PUT /api/me/sidebar-layout            with `version`; stale gets 409 `version_conflict`
//   GET /api/me/pins, GET /api/me/recents, DELETE /api/me/pins/:kind/:id   (never on LAB)
//
// Collapsed (Ctrl B) is not part of the per-person layout: it is remembered per browser
// (DESIGN.md), in localStorage, replacing shadcn's sidebar_state cookie (STRATA-42).
//
// Navigation only: hiding or folding a section grants and refuses nothing.

// ---- Shell side ----

function cloneDefault(): SidebarLayout {
  return {
    order: [...DEFAULT_SIDEBAR_LAYOUT.order],
    hidden: [...DEFAULT_SIDEBAR_LAYOUT.hidden],
    folded: [...DEFAULT_SIDEBAR_LAYOUT.folded],
  };
}

/** A change to the layout, as a function of the layout it applies to. */
export type LayoutChange = (current: SidebarLayout) => SidebarLayout;

/** Where the layout, pins and recents come from. Tests inject a fake. */
export interface SidebarPrefsSource {
  /**
   * The saved layout (or the default), or null when it couldn't be read (defaults apply).
   * readOnly: a LAB station showing the picked person's layout; changes apply on screen for this
   * session and are never saved.
   */
  load(): Promise<{ layout: SidebarLayout; readOnly: boolean } | null>;
  /**
   * Saves `layout`, which `change` made from what was on screen. Resolves with the layout the
   * server now holds (after a version conflict: the newer saved layout with `change` reapplied
   * once), or null to keep what is on screen. Rejects when the server can't be reached.
   */
  save(layout: SidebarLayout, change: LayoutChange): Promise<SidebarLayout | null>;
  /** Pinned records, oldest pin first; null when this account keeps none (LAB, refused). */
  pins(): Promise<SidebarRecord[] | null>;
  /** The last records the person opened, newest first; null as for pins. */
  recents(): Promise<SidebarRecord[] | null>;
  unpin(kind: SidebarRecordKind, id: string): Promise<void>;
}

/** Moves a section one place up (−1) or down (+1) among `among` (what the person sees). */
export function moveSection(
  layout: SidebarLayout,
  id: SidebarSectionId,
  delta: -1 | 1,
  among: readonly SidebarSectionId[] = layout.order,
): SidebarLayout {
  const index = among.indexOf(id);
  const neighbour = index < 0 ? undefined : among[index + delta];
  if (!neighbour) return layout;
  const order = layout.order.filter((item) => item !== id);
  const at = order.indexOf(neighbour);
  order.splice(delta > 0 ? at + 1 : at, 0, id);
  return { ...layout, order };
}

/** Adds (`on`) or removes `id`. */
export function toggleIn<T extends string>(list: T[], id: T, on: boolean): T[] {
  const without = list.filter((item) => item !== id);
  return on ? [...without, id] : without;
}

/** Reset to default: order and visibility back to the default; folds too. */
export function resetLayout(): SidebarLayout {
  return cloneDefault();
}

export const SIDEBAR_LAYOUT_PATH = '/api/me/sidebar-layout';

/**
 * Fired with the person's new Recent list (`detail`, SidebarRecord[]) after a record page was
 * recorded, so the sidebar shows it without asking again.
 */
export const RECENTS_CHANGED_EVENT = 'materialmule:recents-changed';

const layoutOf = (response: SidebarLayoutResponse): SidebarLayout =>
  normalizeSidebarLayout({
    order: response.order,
    hidden: response.hidden,
    folded: response.folded,
  });

async function recordList(path: string): Promise<SidebarRecord[] | null> {
  const response = await apiFetch(path);
  // Refused (LAB, an account without personal settings): the section is hidden.
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return sidebarRecordListSchema.parse(await response.json()).items;
}

/**
 * The server-backed source. `station`: the shared LAB account, which reads the picked person's
 * layout (`personId`) read-only and never asks for pins or recents. `records`: whether this
 * account keeps pins and recents (`personal_settings.manage`).
 */
export function apiPrefsSource({
  station,
  personId,
  records,
}: {
  station: boolean;
  personId: string | null;
  records: boolean;
}): SidebarPrefsSource {
  /** The version last read or saved; sent with every PUT (0 when nothing was saved yet). */
  let version = 0;
  let readOnly = station;
  const withRecords = records && !station;
  return {
    async load() {
      const query = station && personId ? `?${new URLSearchParams({ personId }).toString()}` : '';
      const response = await apiFetch(SIDEBAR_LAYOUT_PATH + query);
      if (!response.ok) return null;
      const saved = sidebarLayoutResponseSchema.parse(await response.json());
      version = saved.version;
      readOnly = station || saved.readOnly;
      return { layout: layoutOf(saved), readOnly };
    },
    async save(layout, change) {
      if (readOnly) return null;
      let body = layout;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await apiFetch(SIDEBAR_LAYOUT_PATH, {
          method: 'PUT',
          body: JSON.stringify({ ...body, version }),
        });
        if (response.ok) {
          const saved = sidebarLayoutResponseSchema.parse(await response.json());
          version = saved.version;
          return layoutOf(saved);
        }
        if (response.status !== 409) return null;
        // Saved elsewhere since it was read: adopt that layout and reapply this change, once.
        const conflict = sidebarLayoutVersionConflictSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!conflict.success) return null;
        version = conflict.data.current.version;
        const current = layoutOf(conflict.data.current);
        if (attempt > 0) return current;
        body = normalizeSidebarLayout(change(current));
      }
      return null;
    },
    pins: () => (withRecords ? recordList('/api/me/pins') : Promise.resolve(null)),
    recents: () => (withRecords ? recordList('/api/me/recents') : Promise.resolve(null)),
    async unpin(kind, id) {
      const response = await apiFetch(
        `/api/me/pins/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
  };
}

/** The one place the shell gets its source. */
export function createSidebarPrefsSource(options: {
  station: boolean;
  personId: string | null;
  records: boolean;
}): SidebarPrefsSource {
  return apiPrefsSource(options);
}

// ---- Collapsed, per browser (STRATA-42) ----

export const SIDEBAR_COLLAPSED_KEY = 'materialmule:sidebar-collapsed';

/** true/false when chosen in this browser; null when never chosen (the window width decides). */
export function readCollapsed(): boolean | null {
  try {
    const value = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch {
    return null;
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

// ---- Hook ----

export interface SidebarPrefs {
  layout: SidebarLayout;
  /** True when changes can't be saved (LAB showing the picked person's layout). */
  readOnly: boolean;
  /**
   * Applies at once and saves in the background. A save that can't reach the server keeps the
   * change on screen, quietly; one that meets a newer saved layout takes it and reapplies this.
   */
  update(next: LayoutChange): void;
  /** null: no Pinned section for this account (LAB, refused). */
  pins: SidebarRecord[] | null;
  /** null: no Recent section for this account. */
  recents: SidebarRecord[] | null;
  unpin(record: SidebarRecord): void;
}

interface PrefsState {
  source: SidebarPrefsSource;
  layout: SidebarLayout;
  readOnly: boolean;
  pins: SidebarRecord[] | null;
  recents: SidebarRecord[] | null;
}

const freshState = (source: SidebarPrefsSource): PrefsState => ({
  source,
  layout: cloneDefault(),
  readOnly: false,
  pins: [],
  recents: [],
});

/**
 * The layout, pins and recents for `source`. A new source (another person signed in, a station
 * changing hands) reloads everything and drops the previous person's layout at once.
 */
export function useSidebarPrefs(source: SidebarPrefsSource): SidebarPrefs {
  const [state, setState] = useState<PrefsState>(() => freshState(source));
  // Identity changed: forget the previous person's layout during render, before it shows.
  const current = state.source === source ? state : freshState(source);
  if (state.source !== source) setState(current);

  // The committed layout, for saves outside render.
  const layoutRef = useRef(current.layout);
  const readOnlyRef = useRef(current.readOnly);
  useLayoutEffect(() => {
    layoutRef.current = current.layout;
    readOnlyRef.current = current.readOnly;
  });
  // The person changed the layout before the saved one arrived: theirs wins.
  const touched = useRef(false);

  useEffect(() => {
    let active = true;
    touched.current = false;
    // A record page reported a newer Recent list before the first read came back: keep it.
    let recentsPushed = false;
    void source.load().then(
      (saved) => {
        if (!active || !saved) return;
        readOnlyRef.current = saved.readOnly;
        setState((s) =>
          s.source !== source
            ? s
            : {
                ...s,
                readOnly: saved.readOnly,
                layout: touched.current ? s.layout : normalizeSidebarLayout(saved.layout),
              },
        );
      },
      () => undefined,
    );
    void Promise.all([
      source.pins().catch(() => [] as SidebarRecord[]),
      source.recents().catch(() => [] as SidebarRecord[]),
    ]).then(([pins, recents]) => {
      if (!active) return;
      setState((s) =>
        s.source === source ? { ...s, pins, recents: recentsPushed ? s.recents : recents } : s,
      );
    });
    const onRecents = (event: Event) => {
      const items = (event as CustomEvent<SidebarRecord[]>).detail;
      if (!Array.isArray(items)) return;
      recentsPushed = true;
      setState((s) => (s.source === source && s.recents !== null ? { ...s, recents: items } : s));
    };
    window.addEventListener(RECENTS_CHANGED_EVENT, onRecents);
    return () => {
      active = false;
      window.removeEventListener(RECENTS_CHANGED_EVENT, onRecents);
    };
  }, [source]);

  const update = useCallback(
    (next: LayoutChange) => {
      const before = layoutRef.current;
      const after = next(before);
      if (after === before) return;
      touched.current = true;
      layoutRef.current = after;
      setState((s) => (s.source === source ? { ...s, layout: after } : s));
      // LAB: the picked person's layout folds for this session only.
      if (readOnlyRef.current) return;
      source.save(after, next).then(
        (saved) => {
          // Something newer is on screen already: that one's save decides.
          if (!saved || layoutRef.current !== after) return;
          layoutRef.current = saved;
          setState((s) => (s.source === source ? { ...s, layout: saved } : s));
        },
        // Offline or refused: keep the change on screen and don't nag.
        () => undefined,
      );
    },
    [source],
  );

  const unpin = useCallback(
    (record: SidebarRecord) => {
      const same = (r: SidebarRecord) => r.kind === record.kind && r.id === record.id;
      let previous: SidebarRecord[] | null = null;
      setState((s) => {
        if (s.source !== source || s.pins === null) return s;
        previous = s.pins;
        return { ...s, pins: s.pins.filter((r) => !same(r)) };
      });
      source.unpin(record.kind, record.id).catch(() => {
        if (previous) setState((s) => (s.source === source ? { ...s, pins: previous } : s));
      });
    },
    [source],
  );

  return {
    layout: current.layout,
    readOnly: current.readOnly,
    update,
    pins: current.pins,
    recents: current.recents,
    unpin,
  };
}
