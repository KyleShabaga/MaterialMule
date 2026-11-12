import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

// One sort/filter/search/view state per table (STRATA-46, 49, 50, 65). The heading sort, the
// toolbar Sort menu, the active chips and the server request all read this one value; it lives in
// the URL so Back and reload restore it. Rows come back from the server already in order and React
// renders them: nothing here reorders DOM rows (the canvas's SortHeader did, STRATA-50).

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDirection;
}

export interface TableQuery {
  /** Search text; empty when none. */
  search: string;
  /** Active filter ids, in the order they were turned on. */
  filters: string[];
  /** Non-default sort; `null` is the page's default order (no chip). */
  sort: SortState | null;
  /** Chosen view id; `null` is the page's default view. */
  view: string | null;
}

export const EMPTY_TABLE_QUERY: TableQuery = { search: '', filters: [], sort: null, view: null };

/** Chip and Sort-button wording for one sortable key, e.g. { asc: 'Title A–Z', desc: 'Title Z–A' }. */
export type SortLabels = Record<string, { asc: string; desc: string }>;

/** An entry in the toolbar's Sort menu. `sort: null` is the default order. */
export interface SortOption {
  label: string;
  sort: SortState | null;
}

export function sameSort(a: SortState | null, b: SortState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.dir === b.dir;
}

/**
 * A heading click cycles one column: ascending, descending, then back to the default order.
 * Clicking a different column starts it at ascending.
 */
export function nextHeadingSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

/**
 * The words for a sort: the matching Sort menu entry first, then the column's labels, then a
 * plain fallback. `null` gives the default option's label (or "Default order").
 */
export function describeSort(
  sort: SortState | null,
  options: readonly SortOption[] = [],
  labels: SortLabels = {},
): string {
  const option = options.find((o) => sameSort(o.sort, sort));
  if (option) return option.label;
  if (!sort) return 'Default order';
  const words = labels[sort.key];
  if (words) return words[sort.dir];
  return `${sort.key} ${sort.dir === 'asc' ? 'ascending' : 'descending'}`;
}

/** URL parameter names. `prefix` lets two tables on one page keep separate state. */
export function tableQueryKeys(prefix = '') {
  return {
    search: `${prefix}search`,
    filter: `${prefix}filter`,
    sort: `${prefix}sort`,
    dir: `${prefix}dir`,
    view: `${prefix}view`,
    page: `${prefix}page`,
  };
}

export function readTableQuery(params: URLSearchParams, prefix = ''): TableQuery {
  const k = tableQueryKeys(prefix);
  const sortKey = params.get(k.sort);
  const dir = params.get(k.dir);
  const filters: string[] = [];
  for (const f of params.getAll(k.filter)) if (f && !filters.includes(f)) filters.push(f);
  return {
    search: params.get(k.search) ?? '',
    filters,
    sort: sortKey ? { key: sortKey, dir: dir === 'desc' ? 'desc' : 'asc' } : null,
    view: params.get(k.view) || null,
  };
}

/**
 * Writes `query` into a copy of `params`, keeping every other parameter (`open`, a host page's
 * own filters). Any change to search, filters or sort resets paging, since the rows on page n
 * are different rows afterwards.
 */
export function writeTableQuery(
  params: URLSearchParams,
  query: TableQuery,
  prefix = '',
): URLSearchParams {
  const k = tableQueryKeys(prefix);
  const next = new URLSearchParams(params);
  const before = readTableQuery(params, prefix);
  const rowsChanged =
    before.search !== query.search ||
    before.filters.join('\n') !== query.filters.join('\n') ||
    !sameSort(before.sort, query.sort);

  if (query.search) next.set(k.search, query.search);
  else next.delete(k.search);
  next.delete(k.filter);
  for (const f of query.filters) next.append(k.filter, f);
  if (query.sort) {
    next.set(k.sort, query.sort.key);
    next.set(k.dir, query.sort.dir);
  } else {
    next.delete(k.sort);
    next.delete(k.dir);
  }
  if (query.view) next.set(k.view, query.view);
  else next.delete(k.view);
  if (rowsChanged) next.delete(k.page);
  return next;
}

export type SetTableQuery = (patch: Partial<TableQuery>) => void;

/**
 * The table's query, kept in the URL. Sort, filter and view changes push a history entry (Back
 * returns to the previous complete query); typing in search replaces the current entry so Back
 * isn't a keystroke-by-keystroke undo.
 */
export function useTableQuery(prefix = ''): [TableQuery, SetTableQuery] {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readTableQuery(params, prefix), [params, prefix]);
  const setQuery = useCallback<SetTableQuery>(
    (patch) => {
      const onlySearch = Object.keys(patch).every((key) => key === 'search');
      setParams(
        (current) =>
          writeTableQuery(current, { ...readTableQuery(current, prefix), ...patch }, prefix),
        { replace: onlySearch },
      );
    },
    [setParams, prefix],
  );
  return [query, setQuery];
}
