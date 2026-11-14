// MM-T30 approval and revocation, used by the Retention page (STRATA-90).
import { apiFetch } from '../api/client';

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
      return {
        ok: false,
        message: 'Only the project’s Lead Project Engineer or a Lab Manager can do that.',
      };
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
