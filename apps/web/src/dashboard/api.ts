import {
  DEFAULT_DATE_FORMAT,
  needsYouResponseSchema,
  PROJECT_LIST_PAGE_SIZE_MAX,
  projectListPageSchema,
  scopedActivityItemSchema,
  type ActivityScope,
  type DateFormatPreference,
  type NeedsYouResponse,
  type ScopedActivityItem,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';
import { fetchPreferences } from '../settings/account/preferences-api';

// Today's data (Strata): Needs you, the last 24 hours, and whether the person leads a project
// (which picks the shortcut set). Every call resolves; a failure carries a message.

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string; forbidden?: boolean };

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function get<T>(path: string, what: string, schema: Schema<T>): Promise<Loaded<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return { ok: false, message: `${what} couldn't load. Check the connection.` };
  }
  if (!response.ok) {
    // No status codes on screen: say what failed and offer Try again.
    return {
      ok: false,
      message: `${what} couldn't load.`,
      forbidden: response.status === 403,
    };
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: `${what} couldn't load: unexpected response.` };
}

/** `GET /api/today/needs-you`: requests waiting on me plus system work (STRATA-56). */
export function fetchNeedsYou(): Promise<Loaded<NeedsYouResponse>> {
  return get('/api/today/needs-you', 'Needs you', needsYouResponseSchema);
}

/** Hours and lines in "Last 24 hours". */
export const ACTIVITY_HOURS = 24;
export const ACTIVITY_LIMIT = 12;

const scopedActivitySchema = scopedActivityItemSchema.array();

/** `GET /api/activity/recent?hours=24&limit=12&scope=` (STRATA-23). */
export function fetchActivity(scope: ActivityScope): Promise<Loaded<ScopedActivityItem[]>> {
  return get(
    `/api/activity/recent?hours=${ACTIVITY_HOURS}&limit=${ACTIVITY_LIMIT}&scope=${scope}`,
    'The last 24 hours',
    scopedActivitySchema,
  );
}

/**
 * Whether the signed-in person is the Lead Project Engineer of any project (My projects, D12
 * involvement). Relevance only: it picks shortcuts and grants nothing. False when unknown.
 */
export async function fetchLeadsAnyProject(): Promise<boolean> {
  const result = await get(
    `/api/projects?mine=true&pageSize=${PROJECT_LIST_PAGE_SIZE_MAX}`,
    'Projects',
    projectListPageSchema,
  );
  return (
    result.ok &&
    result.data.items.some((project) => project.involvement.includes('lead_project_engineer'))
  );
}

/** The person's Date format setting; the default when it can't be read. */
export async function fetchDateFormat(): Promise<DateFormatPreference> {
  try {
    return (await fetchPreferences()).preferences.dateFormat;
  } catch {
    return DEFAULT_DATE_FORMAT;
  }
}
