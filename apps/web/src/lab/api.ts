import {
  acceptanceDelegatesSchema,
  labCommentSchema,
  reviewResultSchema,
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  labSourceListSchema,
  labSourceUnitListSchema,
  programWorkSchema,
  sameSourceUnitsSchema,
  type SameSourceUnits,
  testCatalogueSchema,
  testTemplateListSchema,
  worklistSchema,
  type AcceptanceDelegates,
  type AddCommentRequestInput,
  type ReviewDecisionRequestInput,
  type ChangeTestStatusRequestInput,
  type EditCommentRequestInput,
  type ProgramWork,
  type Worklist,
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
  amendmentResultSchema,
  laterReceiptsSchema,
  lifecycleRequestResultSchema,
  programLifecycleResultSchema,
  testRequestResultSchema,
  type AmendProgramRequestInput,
  type ChangeTestRequestInput,
  type LaterReceipts,
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
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  parse: (body: unknown) => T,
): Promise<WriteResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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

// ---------------------------------------------------------------------------------------------
// Worklist and progress (MM-T24)
// ---------------------------------------------------------------------------------------------

export const fetchWorklist = (query: {
  priority?: string;
  projectId?: string;
  open?: boolean;
  testTypeId?: string;
}): Promise<Worklist> => {
  const params = new URLSearchParams();
  if (query.priority) params.set('priority', query.priority);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.open) params.set('open', 'true');
  if (query.testTypeId) params.set('testTypeId', query.testTypeId);
  return getJson(`/api/worklist?${params.toString()}`, (b) => worklistSchema.parse(b));
};

export const fetchWork = (programId: string): Promise<ProgramWork> =>
  getJson(`/api/lab-programs/${encodeURIComponent(programId)}/work`, (b) =>
    programWorkSchema.parse(b),
  );

/** MM-T73: same-source units outside a test's coverage that its completion may still record. */
export const fetchSameSourceUnits = (testRequestId: string): Promise<SameSourceUnits> =>
  getJson(`/api/test-requests/${encodeURIComponent(testRequestId)}/same-source-units`, (b) =>
    sameSourceUnitsSchema.parse(b),
  );

export const changeStatus = (testRequestId: string, body: ChangeTestStatusRequestInput) =>
  write(`/api/test-requests/${encodeURIComponent(testRequestId)}/status`, 'POST', body, (b) => b);

export const changePriority = (
  programId: string,
  body: { priority: 'normal' | 'urgent'; version: number; idempotencyKey: string },
) => write(`/api/lab-programs/${encodeURIComponent(programId)}/priority`, 'PATCH', body, (b) => b);

export const addComment = (programId: string, body: AddCommentRequestInput) =>
  write(`/api/lab-programs/${encodeURIComponent(programId)}/comments`, 'POST', body, (b) =>
    labCommentSchema.parse(b),
  );

export const editComment = (commentId: string, body: EditCommentRequestInput) =>
  write(`/api/comments/${encodeURIComponent(commentId)}`, 'PATCH', body, (b) =>
    labCommentSchema.parse(b),
  );

// Review corrections and delegated acceptance (MM-T25).

const requestPath = (testRequestId: string, action: string) =>
  `/api/test-requests/${encodeURIComponent(testRequestId)}/${action}`;

export const reviewDecision = (testRequestId: string, body: ReviewDecisionRequestInput) =>
  write(requestPath(testRequestId, 'review'), 'POST', body, (b) => reviewResultSchema.parse(b));

export const markCorrectionDone = (
  testRequestId: string,
  body: { note: string; version: number; idempotencyKey: string; actionItemId?: string },
) =>
  write(requestPath(testRequestId, 'correction-done'), 'POST', body, (b) =>
    reviewResultSchema.parse(b),
  );

export const acceptTest = (
  testRequestId: string,
  body: { version: number; idempotencyKey: string },
) => write(requestPath(testRequestId, 'accept'), 'POST', body, (b) => reviewResultSchema.parse(b));

const delegatesPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/acceptance-delegates`;

export const fetchDelegates = (projectId: string): Promise<AcceptanceDelegates> =>
  getJson(delegatesPath(projectId), (b) => acceptanceDelegatesSchema.parse(b));

export const grantDelegate = (
  projectId: string,
  body: { delegateUserId: string; idempotencyKey: string },
) => write(delegatesPath(projectId), 'POST', body, (b) => acceptanceDelegatesSchema.parse(b));

export const revokeDelegate = (projectId: string, delegationId: string) =>
  write(
    `${delegatesPath(projectId)}/${encodeURIComponent(delegationId)}`,
    'DELETE',
    undefined,
    (b) => acceptanceDelegatesSchema.parse(b),
  );

// Program lifecycle, cancellation and repeats (MM-T26).

const programPath = (programId: string, action: string) =>
  `/api/lab-programs/${encodeURIComponent(programId)}/${action}`;

export const closeProgram = (
  programId: string,
  body: { version: number; idempotencyKey: string },
) =>
  write(programPath(programId, 'close'), 'POST', body, (b) =>
    programLifecycleResultSchema.parse(b),
  );

export const reopenProgram = (
  programId: string,
  body: { reason: string; version: number; idempotencyKey: string },
) =>
  write(programPath(programId, 'reopen'), 'POST', body, (b) =>
    programLifecycleResultSchema.parse(b),
  );

export const requestClosure = (
  programId: string,
  body: { reason: string; idempotencyKey: string },
) =>
  write(programPath(programId, 'close-request'), 'POST', body, (b) =>
    lifecycleRequestResultSchema.parse(b),
  );

export const cancelTest = (
  testRequestId: string,
  body: { reason: string; version: number; idempotencyKey: string },
) =>
  write(requestPath(testRequestId, 'cancel'), 'POST', body, (b) =>
    testRequestResultSchema.parse(b),
  );

export const requestCancellation = (
  testRequestId: string,
  body: { reason: string; idempotencyKey: string },
) =>
  write(requestPath(testRequestId, 'cancel-request'), 'POST', body, (b) =>
    lifecycleRequestResultSchema.parse(b),
  );

export const repeatTest = (
  testRequestId: string,
  body: { version: number; idempotencyKey: string },
) =>
  write(requestPath(testRequestId, 'repeat'), 'POST', body, (b) =>
    testRequestResultSchema.parse(b),
  );

export const changeTestRequest = (testRequestId: string, body: ChangeTestRequestInput) =>
  write(`/api/test-requests/${encodeURIComponent(testRequestId)}`, 'PATCH', body, (b) =>
    testRequestResultSchema.parse(b),
  );

export const fetchLaterReceipts = (programId: string): Promise<LaterReceipts> =>
  getJson(programPath(programId, 'later-receipts'), (b) => laterReceiptsSchema.parse(b));

export const amendProgram = (programId: string, body: AmendProgramRequestInput) =>
  write(programPath(programId, 'amend'), 'POST', body, (b) => amendmentResultSchema.parse(b));
