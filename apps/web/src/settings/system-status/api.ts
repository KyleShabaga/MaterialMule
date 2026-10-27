import { systemStatusResponseSchema, type SystemStatusResponse } from '@materialmule/shared';
import { apiFetch } from '../../api/client';

/** `GET /api/admin/system-status` (MM-T21): Settings → System status and the dashboard. */
export async function fetchSystemStatus(): Promise<
  { ok: true; data: SystemStatusResponse } | { ok: false; message: string }
> {
  let response: Response;
  try {
    response = await apiFetch('/api/admin/system-status');
  } catch {
    return { ok: false, message: "Material Mule couldn't be reached. Check the connection." };
  }
  if (!response.ok) {
    return {
      ok: false,
      message:
        response.status === 403
          ? "You don't have permission to see system status."
          : "System status couldn't load. Try again.",
    };
  }
  const parsed = systemStatusResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: 'Material Mule returned an unexpected response.' };
}
