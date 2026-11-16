import type { ConcreteSearch, InventoryPage, ProjectSummary } from '@materialmule/shared';
import { useEffect, useRef, useState } from 'react';
import { FEATURES } from '../features';
import { searchConcrete, searchProjects, searchUnits, type SearchResult } from './api';
import { isEditableOrDialogTarget } from './scan-anywhere';

// The Ctrl K menu's behaviour without its UI: query rules, global shortcuts and the debounced,
// stale-safe live search (STRATA-14).

/** Rows the menu lists per kind before "Show all results". */
export const MENU_PREVIEW = 5;
/** Pause after typing before the live search runs. A scan or Enter never waits. */
export const MENU_DEBOUNCE_MS = 200;
/** The longest query sent (as the old top-bar field allowed). */
export const MENU_MAX_QUERY = 100;
export const MENU_PLACEHOLDER = 'Search or scan a label…';
/** The input's accessible name (cmdk labels it from the Command's label). */
export const MENU_LABEL = 'Search or scan a label';
export const NO_MATCH = 'Nothing matches. Check the ID, or scan the label again.';

/** Trimmed, inner whitespace collapsed, at most MENU_MAX_QUERY characters. */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MENU_MAX_QUERY);
}

/** Whether focus is in some other dialog than the command menu (its keys are its own). */
function inOtherDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('[role="dialog"], [role="alertdialog"], dialog') &&
    !target.closest('[data-command-menu]')
  );
}

/**
 * Ctrl K / ⌘K toggles from anywhere (also from a field: it is a modifier shortcut); "/" opens and
 * "?" opens Keyboard shortcuts, but never while typing in a field or inside another dialog.
 */
export function useMenuShortcuts(actions: {
  toggle: () => void;
  open: () => void;
  openShortcuts: () => void;
}): void {
  const ref = useRef(actions);
  useEffect(() => {
    ref.current = actions;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (inOtherDialog(event.target)) return;
        event.preventDefault();
        ref.current.toggle();
        return;
      }
      if (mod || event.altKey) return;
      if (event.key !== '/' && event.key !== '?') return;
      if (isEditableOrDialogTarget(event.target)) return;
      event.preventDefault();
      if (event.key === '/') ref.current.open();
      else ref.current.openShortcuts();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

export interface LiveResults {
  q: string;
  units: SearchResult<InventoryPage> | null;
  projects: SearchResult<ProjectSummary[]> | null;
  concrete: SearchResult<ConcreteSearch> | null;
}

/**
 * Debounced live search across units, projects and concrete records. Only the newest query's
 * answer is ever shown: an older response arriving late is dropped (stale-response rule).
 */
export function useLiveSearch(
  q: string,
  options: { canRead: boolean; immediateFor?: string; debounceMs?: number },
): { results: LiveResults | null; loading: boolean } {
  const [results, setResults] = useState<LiveResults | null>(null);
  const latest = useRef(0);
  const { canRead, immediateFor, debounceMs = MENU_DEBOUNCE_MS } = options;
  useEffect(() => {
    if (!q || !canRead) return;
    const token = ++latest.current;
    const timer = setTimeout(
      () => {
        void Promise.all([
          searchUnits(q, MENU_PREVIEW),
          searchProjects(q),
          FEATURES.concreteLab ? searchConcrete(q) : Promise.resolve(null),
        ]).then(([units, projects, concrete]) => {
          if (token === latest.current) setResults({ q, units, projects, concrete });
        });
      },
      q === immediateFor ? 0 : debounceMs,
    );
    return () => clearTimeout(timer);
  }, [q, canRead, immediateFor, debounceMs]);
  const current = results?.q === q ? results : null;
  return { results: current, loading: !!q && canRead && current === null };
}
