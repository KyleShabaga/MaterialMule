import {
  concreteFieldReportListSchema,
  concreteMixDetailSchema,
  concreteMixListSchema,
  concreteMixPropagationPreviewSchema,
  concreteMixPropagationResultSchema,
  concreteProjectSettingsSchema,
  concreteProjectSetListSchema,
  concreteSummaryReportListSchema,
  concreteSummaryReportSchema,
  type ConcreteSummaryFilters,
  type ConcreteSummaryReport,
  type ConcreteSummaryReportList,
  type ConcreteFieldReportList,
  type ConcreteMixDetail,
  type ConcreteMixList,
  type ConcreteMixPropagationDecision,
  type ConcreteMixPropagationPreview,
  type ConcreteMixPropagationResult,
  type ConcreteProjectSettings,
  type ConcreteProjectSetList,
  type CopyConcreteMixRequest,
  type CreateConcreteMixRequest,
  type DiscardConcreteMixDraftRequest,
  type UpdateConcreteMixRequest,
  type UpdateConcreteSettingsRequest,
  type ApproveConcreteMixRequest,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// MM-V2-C30, STRATA-98: the project Concrete tab (Field reports, Sets, Mixes, Summary, Settings)
// and the mix propagation review. Every call throws ConcreteApiError on a refusal so the screen
// keeps the person's input and can say why.

export class ConcreteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly errors: { field: string; message: string }[] = [],
    readonly body: unknown = null,
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

async function failure(response: Response): Promise<ConcreteApiError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    errors?: unknown;
  } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const errors = Array.isArray(body?.errors)
    ? (body.errors as { field?: unknown; path?: unknown; message?: unknown }[]).map((e) => ({
        field: String(e.field ?? (Array.isArray(e.path) ? e.path.join('.') : '')),
        message: String(e.message ?? ''),
      }))
    : [];
  return new ConcreteApiError(response.status, code, errors, body);
}

async function call<T>(
  path: string,
  parse: (body: unknown) => T,
  init?: { method: string; body: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(
      path,
      init ? { method: init.method, body: JSON.stringify(init.body) } : {},
    );
  } catch {
    throw new ConcreteApiError(0, 'unreachable');
  }
  if (!response.ok) throw await failure(response);
  return parse(await response.json());
}

const project = (id: string, rest: string) => `/api/projects/${encodeURIComponent(id)}${rest}`;
const mix = (id: string, rest = '') => `/api/concrete-mixes/${encodeURIComponent(id)}${rest}`;

export function search(params: Record<string, string | number | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

// ---- Field reports and Sets ----------------------------------------------------------------------

export function fetchProjectReports(
  projectId: string,
  query: {
    search?: string;
    state?: string;
    issued?: string;
    technicianUserId?: string;
    page?: number;
  },
): Promise<ConcreteFieldReportList> {
  return call(
    `/api/concrete/projects/${encodeURIComponent(projectId)}/field-reports${search({ ...query, pageSize: 25 })}`,
    (b) => concreteFieldReportListSchema.parse(b),
  );
}

/** STRATA-98: the Sets sub-tab, one row per specimen set, newest first. */
export function fetchProjectSets(
  projectId: string,
  query: { search?: string; page?: number },
): Promise<ConcreteProjectSetList> {
  return call(
    `/api/concrete/projects/${encodeURIComponent(projectId)}/specimen-sets${search(query)}`,
    (b) => concreteProjectSetListSchema.parse(b),
  );
}

// ---- Mixes ---------------------------------------------------------------------------------------

export function fetchMixes(
  projectId: string,
  query: { search?: string; status?: string; page?: number } = {},
): Promise<ConcreteMixList> {
  return call(project(projectId, `/concrete-mixes${search({ ...query, pageSize: 50 })}`), (b) =>
    concreteMixListSchema.parse(b),
  );
}

export function fetchMix(id: string): Promise<ConcreteMixDetail> {
  return call(mix(id), (b) => concreteMixDetailSchema.parse(b));
}

export function createMix(
  projectId: string,
  body: CreateConcreteMixRequest,
): Promise<ConcreteMixDetail> {
  return call(project(projectId, '/concrete-mixes'), (b) => concreteMixDetailSchema.parse(b), {
    method: 'POST',
    body,
  });
}

export function copyMix(
  projectId: string,
  body: CopyConcreteMixRequest,
): Promise<ConcreteMixDetail> {
  return call(project(projectId, '/concrete-mixes/copy'), (b) => concreteMixDetailSchema.parse(b), {
    method: 'POST',
    body,
  });
}

export function updateMix(id: string, body: UpdateConcreteMixRequest): Promise<ConcreteMixDetail> {
  return call(mix(id), (b) => concreteMixDetailSchema.parse(b), { method: 'PATCH', body });
}

export function approveMix(
  id: string,
  body: ApproveConcreteMixRequest,
): Promise<ConcreteMixDetail> {
  return call(mix(id, '/approve'), (b) => concreteMixDetailSchema.parse(b), {
    method: 'POST',
    body,
  });
}

export function fetchPropagation(id: string): Promise<ConcreteMixPropagationPreview> {
  return call(mix(id, '/propagation'), (b) => concreteMixPropagationPreviewSchema.parse(b));
}

export function applyPropagation(
  id: string,
  body: ConcreteMixPropagationDecision,
): Promise<ConcreteMixPropagationResult> {
  return call(mix(id, '/propagation'), (b) => concreteMixPropagationResultSchema.parse(b), {
    method: 'POST',
    body,
  });
}

// ---- Settings ------------------------------------------------------------------------------------

export function fetchSettings(projectId: string): Promise<ConcreteProjectSettings> {
  return call(project(projectId, '/concrete-settings'), (b) =>
    concreteProjectSettingsSchema.parse(b),
  );
}

export function saveSettings(
  projectId: string,
  body: UpdateConcreteSettingsRequest,
): Promise<ConcreteProjectSettings> {
  return call(
    project(projectId, '/concrete-settings'),
    (b) => concreteProjectSettingsSchema.parse(b),
    {
      method: 'PATCH',
      body,
    },
  );
}

// ---- Summary report (MM-V2-C32) -------------------------------------------------------------------

const summaries = (projectId: string, rest = '') =>
  `/api/concrete/projects/${encodeURIComponent(projectId)}/summary-reports${rest}`;

export function fetchSummaryReports(projectId: string): Promise<ConcreteSummaryReportList> {
  return call(summaries(projectId), (b) => concreteSummaryReportListSchema.parse(b));
}

/** The unnumbered preview PDF (rendered by the server, never stored). */
export function summaryPreviewUrl(projectId: string, filters: ConcreteSummaryFilters): string {
  return summaries(
    projectId,
    `/preview${search({
      from: filters.from ?? undefined,
      to: filters.to ?? undefined,
      element: filters.element ?? undefined,
      mixId: filters.mixId ?? undefined,
    })}`,
  );
}

export function issueSummaryReport(
  projectId: string,
  filters: ConcreteSummaryFilters,
): Promise<ConcreteSummaryReport> {
  return call(summaries(projectId), (b) => concreteSummaryReportSchema.parse(b), {
    method: 'POST',
    body: { idempotencyKey: crypto.randomUUID(), filters },
  });
}

// ---- Messages ------------------------------------------------------------------------------------

/** A plain sentence for a refusal on the Concrete screens. */
/** Discard the open draft revision of an approved mix (the Lead; MM-V2-C37). */
export function discardMixDraft(
  mixId: string,
  body: DiscardConcreteMixDraftRequest,
): Promise<ConcreteMixDetail> {
  return call(mix(mixId, '/discard-draft'), (b) => concreteMixDetailSchema.parse(b), {
    method: 'POST',
    body,
  });
}

/** Link a listed supplier to the mix, or null to unlink (the Lead; MM-V2-C37). */
export function linkMixSupplier(
  mixId: string,
  body: { idempotencyKey: string; version: number; supplierId: string | null },
): Promise<ConcreteMixDetail> {
  return call(mix(mixId), (b) => concreteMixDetailSchema.parse(b), { method: 'PATCH', body });
}

export function concreteProblem(error: unknown): string {
  if (!(error instanceof ConcreteApiError)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'unreachable':
      return 'Material Mule couldn’t be reached. Check the connection and try again.';
    case 'forbidden':
      return 'Only the project’s Lead Project Engineer can do this.';
    case 'version_conflict':
      return 'Someone changed this while you had it open. It has been reloaded; check it and try again.';
    case 'mix_number_taken':
      return 'This project already has this mix number from this supplier.';
    case 'incomplete_for_approval':
      return `Fill in every required value before approving: ${error.errors.map((e) => e.field.replace('spec.', '')).join(', ')}.`;
    case 'preview_stale':
      return 'The affected records changed since this list was shown. It has been reloaded; check it and decide again.';
    case 'item_not_eligible':
      return error.errors[0]?.message ?? 'One of the chosen records can’t be updated.';
    case 'nothing_to_apply':
      return 'None of the listed records can be updated from the mix.';
    case 'no_approved_revision':
      return 'This mix has no approved revision yet, so its draft stays.';
    case 'revision_not_draft':
      return 'That revision is no longer the open draft. Reload and try again.';
    case 'invalid_supplier':
      return 'Choose an active listed supplier.';
    default:
      if (error.status === 400 || error.status === 422) {
        return error.errors.map((e) => e.message).join('; ') || 'Check the entries and try again.';
      }
      return 'The server had a problem. Try again in a minute.';
  }
}
