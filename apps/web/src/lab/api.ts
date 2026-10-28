import {
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  labSourceListSchema,
  labSourceUnitListSchema,
  testCatalogueSchema,
  testTemplateListSchema,
  type CreateLabProgramRequestInput,
  type DiscardLabProgramRequest,
  type FieldError,
  type LabProgram,
  type LabProgramList,
  type LabProgramReview,
  type LabSource,
  type LabSourceRef,
  type LabSourceUnit,
  type SubmitLabProgramRequestInput,
  type TestCatalogue,
  type TestTemplate,
  type UpdateLabProgramRequestInput,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Lab Testing API calls (MM-T23). Writes return a result union so screens can keep the person's
// unsaved input on a conflict or validation problem instead of losing it.

export type WriteResult<T> =
  | { ok: true; value: T; status: number }
  | { ok: false; kind: 'conflict'; code: string; current?: LabProgram; review?: LabProgramReview }
  | { ok: false; kind: 'invalid'; code: string; errors: FieldError[]; review?: LabProgramReview }
  | { ok: false; kind: 'forbidden' | 'not_found' | 'unauthenticated' | 'network' | 'error' };

async function getJson<T>(path: string, parse: (body: unknown) => T): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parse(await response.json());
}

async function write<T>(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  parse: (body: unknown) => T,
): Promise<WriteResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method, body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'network' };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: parse(json), status: response.status };
  const code = typeof json?.code === 'string' ? json.code : 'error';
  const review = json?.review ? labProgramReviewSchema.safeParse(json.review) : null;
  if (response.status === 409) {
    const current = json?.current ? labProgramSchema.safeParse(json.current) : null;
    return {
      ok: false,
      kind: 'conflict',
      code,
      current: current?.success ? current.data : undefined,
      review: review?.success ? review.data : undefined,
    };
  }
  if (response.status === 400 || response.status === 422) {
    return {
      ok: false,
      kind: 'invalid',
      code,
      errors: Array.isArray(json?.errors) ? (json.errors as FieldError[]) : [],
      review: review?.success ? review.data : undefined,
    };
  }
  if (response.status === 401) return { ok: false, kind: 'unauthenticated' };
  if (response.status === 403) return { ok: false, kind: 'forbidden' };
  if (response.status === 404) return { ok: false, kind: 'not_found' };
  return { ok: false, kind: 'error' };
}

export const fetchCatalogue = (): Promise<TestCatalogue> =>
  getJson('/api/test-catalogue', (b) => testCatalogueSchema.parse(b));

export const fetchTemplates = (): Promise<TestTemplate[]> =>
  getJson('/api/test-templates', (b) => testTemplateListSchema.parse(b));

export const fetchPrograms = (status?: string): Promise<LabProgramList> =>
  getJson(`/api/lab-programs${status ? `?status=${encodeURIComponent(status)}` : ''}`, (b) =>
    labProgramListSchema.parse(b),
  );

export async function fetchProgram(id: string): Promise<LabProgram | null> {
  const response = await apiFetch(`/api/lab-programs/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return labProgramSchema.parse(await response.json());
}

export const fetchReview = (id: string): Promise<LabProgramReview> =>
  getJson(`/api/lab-programs/${encodeURIComponent(id)}/review`, (b) =>
    labProgramReviewSchema.parse(b),
  );

export const fetchSources = (projectId: string): Promise<LabSource[]> =>
  getJson(`/api/projects/${encodeURIComponent(projectId)}/lab-sources`, (b) =>
    labSourceListSchema.parse(b),
  );

export const fetchSourceUnits = (
  projectId: string,
  source: LabSourceRef,
): Promise<LabSourceUnit[]> =>
  getJson(
    `/api/projects/${encodeURIComponent(projectId)}/lab-sources/${source.kind}/${encodeURIComponent(source.id)}/units`,
    (b) => labSourceUnitListSchema.parse(b),
  );

export const createProgram = (body: CreateLabProgramRequestInput) =>
  write('/api/lab-programs', 'POST', body, (b) => labProgramSchema.parse(b));

export const saveProgram = (id: string, body: UpdateLabProgramRequestInput) =>
  write(`/api/lab-programs/${encodeURIComponent(id)}`, 'PATCH', body, (b) =>
    labProgramSchema.parse(b),
  );

export const submitProgram = (id: string, body: SubmitLabProgramRequestInput) =>
  write(`/api/lab-programs/${encodeURIComponent(id)}/submit`, 'POST', body, (b) =>
    labProgramSchema.parse(b),
  );

export const discardProgram = (id: string, body: DiscardLabProgramRequest) =>
  write(`/api/lab-programs/${encodeURIComponent(id)}/discard`, 'POST', body, () => null);

/** Catalogue administration (Lab Manager / admin). */
export const catalogueWrite = <T>(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  parse: (b: unknown) => T,
) => write(path, method, body, parse);
