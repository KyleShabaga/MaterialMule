import {
  disposalCandidatesSchema,
  disposalScanResultSchema,
  type DisposalCandidates,
  type DisposalScanResult,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

export async function fetchCandidates(
  projectId: string,
  page = 1,
): Promise<DisposalCandidates | null> {
  try {
    const response = await apiFetch(
      `/api/disposal/eligible?projectId=${encodeURIComponent(projectId)}&page=${page}`,
    );
    if (!response.ok) return null;
    return disposalCandidatesSchema.parse(await response.json());
  } catch {
    return null;
  }
}

type Outcome = { ok: true } | { ok: false; message: string };

async function post(path: string, body: unknown): Promise<Outcome> {
  try {
    const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
    if (response.ok) return { ok: true };
    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
      units?: { readableId: string; blockers: { label: string }[] }[];
    };
    if (problem.code === 'not_eligible' && problem.units) {
      return {
        ok: false,
        message: `Not approved. ${problem.units
          .map((u) => `${u.readableId}: ${u.blockers.map((b) => b.label).join(', ')}`)
          .join('; ')}`,
      };
    }
    if (problem.code === 'forbidden') {
      return { ok: false, message: 'Only the project’s PM/PE or a Lab Manager can do that.' };
    }
    return { ok: false, message: 'That didn’t work. Refresh and try again.' };
  } catch {
    return { ok: false, message: 'Material Mule couldn’t be reached. Try again.' };
  }
}

export const approveUnits = (unitIds: string[], idempotencyKey: string) =>
  post('/api/disposal/approvals', { unitIds, idempotencyKey });

export const revokeApproval = (id: string, reason: string, idempotencyKey: string) =>
  post(`/api/disposal/approvals/${id}/revoke`, { reason, idempotencyKey });

/** One disposal scan; never queued. A connection failure says nothing was recorded. */
export async function scanForDisposal(
  suNumber: string,
  idempotencyKey: string,
): Promise<DisposalScanResult | { result: 'error'; message: string }> {
  try {
    const response = await apiFetch('/api/disposal/remove', {
      method: 'POST',
      body: JSON.stringify({ suNumber, idempotencyKey }),
    });
    const body = await response.json().catch(() => null);
    const parsed = disposalScanResultSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    if (response.status === 403) {
      return { result: 'error', message: 'Disposal scans need a personal sign-in.' };
    }
    return { result: 'error', message: 'Not recorded. Try the scan again.' };
  } catch {
    return {
      result: 'error',
      message: 'Not recorded: Material Mule couldn’t be reached. Nothing was queued.',
    };
  }
}
