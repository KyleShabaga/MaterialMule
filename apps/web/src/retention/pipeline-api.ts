import {
  removeFromDisposalListResultSchema,
  retentionDecisionResultSchema,
  retentionDecisionUnitsSchema,
  retentionPipelineSchema,
  type RemoveFromDisposalListResult,
  type RetentionDecision,
  type RetentionDecisionResult,
  type RetentionDecisionUnits,
  type RetentionPipeline,
} from '@materialmule/shared';
import { announceActionRequestsChanged } from '../action-requests/api';
import { apiFetch } from '../api/client';

// STRATA-90/91 client for the Retention pipeline, the decision drawer's units and decisions, and
// taking units off the disposal list. The server decides everything; these only carry results.

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

const UNREACHABLE =
  'Material Mule couldn’t be reached. Check that this computer is on the office network, then try again.';

async function load<T>(path: string, parse: (body: unknown) => T): Promise<Loaded<T>> {
  try {
    const response = await apiFetch(path);
    if (!response.ok) {
      return {
        ok: false,
        message:
          response.status === 404
            ? 'Not found. It may have been removed.'
            : 'It couldn’t load. Nothing was changed. Try again.',
      };
    }
    return { ok: true, data: parse(await response.json()) };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export function fetchPipeline(query: URLSearchParams): Promise<Loaded<RetentionPipeline>> {
  return load(`/api/retention/pipeline?${query.toString()}`, (body) =>
    retentionPipelineSchema.parse(body),
  );
}

/** The drawer's units: explicit unit IDs (any page: Retention, Today, Inbox) or a whole project. */
export function fetchDecisionUnits(
  target: { unitIds: readonly string[] } | { projectId: string },
): Promise<Loaded<RetentionDecisionUnits>> {
  const query =
    'projectId' in target
      ? `projectId=${encodeURIComponent(target.projectId)}`
      : `ids=${target.unitIds.map(encodeURIComponent).join(',')}`;
  return load(`/api/retention/decision-units?${query}`, (body) =>
    retentionDecisionUnitsSchema.parse(body),
  );
}

const MESSAGES: Record<string, string> = {
  forbidden: 'Only the project’s lead or a Lab Manager can decide this. Send a request instead.',
  validation_failed:
    'Check the form: a reason is required, and an extension needs a date or months.',
  idempotency_key_reused: 'That was already sent. Refresh to see the latest.',
  retain_until_too_early: 'An extension can only make retain-until later.',
  storage_unit_not_found: 'A unit wasn’t found. Refresh and try again.',
  not_eligible: 'Not approved: a unit isn’t eligible now.',
};

export type Posted<T> = { ok: true; data: T } | { ok: false; message: string };

async function post<T>(
  path: string,
  body: unknown,
  parse: (body: unknown) => T,
): Promise<Posted<T>> {
  try {
    const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, data: parse(payload) };
    const code = (payload as { code?: string }).code ?? '';
    return {
      ok: false,
      message: MESSAGES[code] ?? 'That didn’t work. Nothing was changed. Try again.',
    };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export function postDecision(body: RetentionDecision): Promise<Posted<RetentionDecisionResult>> {
  return post('/api/retention/decisions', body, (payload) =>
    retentionDecisionResultSchema.parse(payload),
  );
}

/** Sends one retention request per project (requesters: "Request hold or extension"). */
export async function postRetentionRequest(body: {
  kind: 'hold' | 'extension';
  projectId: string;
  unitIds?: string[];
  retainUntil?: string;
  extendMonths?: number;
  holdUntil?: string;
  reason: string;
  idempotencyKey: string;
}): Promise<Posted<unknown>> {
  const { unitIds, ...rest } = body;
  const result = await post(
    '/api/retention/requests',
    unitIds ? { ...rest, scope: 'units', unitIds } : { ...rest, scope: 'project' },
    (payload) => payload,
  );
  if (result.ok) announceActionRequestsChanged();
  return result;
}

export function removeFromList(
  unitIds: string[],
  reason: string,
  idempotencyKey: string,
): Promise<Posted<RemoveFromDisposalListResult>> {
  return post('/api/disposal/list/remove', { unitIds, reason, idempotencyKey }, (payload) =>
    removeFromDisposalListResultSchema.parse(payload),
  );
}

/** Lets the Retention page (and Today/Inbox counts) refresh after a decision anywhere. */
export const RETENTION_CHANGED_EVENT = 'materialmule:retention-changed';
export function announceRetentionChanged(): void {
  window.dispatchEvent(new Event(RETENTION_CHANGED_EVENT));
}
