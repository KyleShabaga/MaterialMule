import {
  PROJECT_LIST_PAGE_SIZE_DEFAULT,
  PROJECT_LIST_PAGE_SIZE_MAX,
  PROJECT_LIST_SORTS,
  type ProjectListSort,
} from '@materialmule/shared';
import type { SortState, TableQuery } from '../components/strata/table-query';

// Projects list state lives in the URL (STRATA-83): the tab (`tab=mine|all|waiting`), the table
// query from useTableQuery (`search`, `sort`, `dir`) and paging (`page`, `pageSize`), so a view
// can be shared and Back returns to it.

export const PROJECTS_TABS = ['mine', 'all', 'waiting'] as const;
export type ProjectsTab = (typeof PROJECTS_TABS)[number];

const truthy = (value: string | null) => value === 'true' || value === '1';
const falsy = (value: string | null) => value === 'false' || value === '0';

/**
 * The open tab. `tab` wins; links from before the tabs keep working: `waitingForLead=true` opens
 * Waiting for a lead, `mine=true` My projects, `mine=false` All projects, and a search link with
 * no tab (Search › Show all in Projects) searches All projects. Otherwise My projects, the
 * default, except where there is no "my" (the shared LAB account): All projects.
 */
export function readProjectsTab(params: URLSearchParams, canMine: boolean): ProjectsTab {
  const tab = params.get('tab');
  let chosen: ProjectsTab;
  if (tab && (PROJECTS_TABS as readonly string[]).includes(tab)) chosen = tab as ProjectsTab;
  else if (truthy(params.get('waitingForLead'))) chosen = 'waiting';
  else if (truthy(params.get('mine'))) chosen = 'mine';
  else if (falsy(params.get('mine')) || params.get('search')) chosen = 'all';
  else chosen = 'mine';
  return chosen === 'mine' && !canMine ? 'all' : chosen;
}

/** The URL for another tab: legacy parameters and paging go, the search stays. */
export function projectsTabParams(params: URLSearchParams, tab: ProjectsTab): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['mine', 'waitingForLead', 'page']) next.delete(key);
  next.set('tab', tab);
  return next;
}

function pageParam(params: URLSearchParams, key: string, fallback: number, max: number): number {
  const n = Number.parseInt(params.get(key) ?? '', 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export function readPage(params: URLSearchParams): number {
  return pageParam(params, 'page', 1, 100_000);
}

export function readPageSize(params: URLSearchParams): number {
  return pageParam(params, 'pageSize', PROJECT_LIST_PAGE_SIZE_DEFAULT, PROJECT_LIST_PAGE_SIZE_MAX);
}

function isProjectSort(key: string): key is ProjectListSort {
  return (PROJECT_LIST_SORTS as readonly string[]).includes(key);
}

/** A sort the server accepts, or null (the default, project number A–Z). */
export function projectListSort(sort: SortState | null): SortState | null {
  return sort && isProjectSort(sort.key) ? sort : null;
}

/** `GET /api/projects` parameters for the open tab, the table query and the page. */
export function projectListRequest(
  tab: ProjectsTab,
  query: Pick<TableQuery, 'search' | 'sort'>,
  page: number,
  pageSize: number,
): URLSearchParams {
  const params = new URLSearchParams();
  const search = query.search.trim();
  if (search) params.set('search', search);
  if (tab === 'mine') params.set('mine', 'true');
  if (tab === 'waiting') params.set('waitingForLead', 'true');
  const sort = projectListSort(query.sort);
  if (sort) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }
  if (page > 1) params.set('page', String(page));
  if (pageSize !== PROJECT_LIST_PAGE_SIZE_DEFAULT) params.set('pageSize', String(pageSize));
  return params;
}
