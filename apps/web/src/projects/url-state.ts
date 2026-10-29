import {
  PROJECT_LIST_PAGE_SIZE_DEFAULT,
  projectListQuerySchema,
  type ProjectListQuery,
} from '@materialmule/shared';

// Projects table state lives in the URL query (MM-T35), using the API's parameter names, so a
// view can be shared and Back returns to it. "Only mine" is also remembered per user in local
// storage and applies whenever the URL doesn't say.

const KEYS = ['search', 'mine', 'waitingForLead', 'sort', 'dir', 'page', 'pageSize'] as const;

/** Reads the query from the URL; invalid values fall back to defaults. */
export function readProjectListQuery(
  params: URLSearchParams,
  rememberedMine: boolean,
): ProjectListQuery {
  const raw: Record<string, string> = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  if (raw.mine === undefined && rememberedMine) raw.mine = 'true';
  const first = projectListQuerySchema.safeParse(raw);
  if (first.success) return first.data;
  for (const issue of first.error.issues) {
    delete raw[String(issue.path[0])];
  }
  return projectListQuerySchema.safeParse(raw).data ?? projectListQuerySchema.parse({});
}

/** URL query for `query`, leaving out defaults (but always stating "Only mine" when it's on). */
export function projectListSearchParams(query: ProjectListQuery): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined, fallback?: string | number) => {
    if (value !== undefined && value !== '' && value !== fallback) params.set(key, String(value));
  };
  set('search', query.search);
  if (query.mine) params.set('mine', 'true');
  if (query.waitingForLead) params.set('waitingForLead', 'true');
  set('sort', query.sort, 'number');
  set('dir', query.dir);
  set('page', query.page, 1);
  set('pageSize', query.pageSize, PROJECT_LIST_PAGE_SIZE_DEFAULT);
  return params;
}

function onlyMineKey(userId: string): string {
  return `materialmule.projects.onlyMine.${userId}`;
}

/** The user's remembered "Only mine" choice; false when storage is unavailable. */
export function readOnlyMine(userId: string): boolean {
  try {
    return window.localStorage.getItem(onlyMineKey(userId)) === 'true';
  } catch {
    return false;
  }
}

export function rememberOnlyMine(userId: string, value: boolean): void {
  try {
    window.localStorage.setItem(onlyMineKey(userId), value ? 'true' : 'false');
  } catch {
    // Private windows may refuse storage; the URL still carries the choice.
  }
}
