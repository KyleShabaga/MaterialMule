import {
  worklistSchema,
  type WorkboardColumn,
  type Worklist,
  type WorklistSort,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// Workboard reads (STRATA-88): GET /api/worklist with the table tools' query. Read-only.

export interface WorkboardQuery {
  search?: string;
  priority?: 'urgent' | 'normal';
  open?: boolean;
  projectIds?: readonly string[];
  column?: WorkboardColumn;
  sort?: WorklistSort;
  page?: number;
}

/** The query string, in a fixed order (tests and caches compare it). */
export function workboardParams(query: WorkboardQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.column) params.set('column', query.column);
  if (query.search) params.set('search', query.search);
  if (query.priority) params.set('priority', query.priority);
  for (const id of query.projectIds ?? []) params.append('projectId', id);
  if (query.open) params.set('open', 'true');
  if (query.sort) params.set('sort', query.sort);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  return params;
}

export async function fetchWorkboard(
  query: WorkboardQuery,
  signal?: AbortSignal,
): Promise<Worklist> {
  const response = await apiFetch(`/api/worklist?${workboardParams(query).toString()}`, {
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return worklistSchema.parse(await response.json());
}
