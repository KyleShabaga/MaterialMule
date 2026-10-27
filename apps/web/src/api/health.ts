import { healthResponseSchema, type HealthResponse } from '@materialmule/shared';

export type HealthResult =
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'degraded'; health: HealthResponse }
  | { kind: 'unavailable'; reason: string };

/** Calls GET /api/health. Never throws: network and parse failures become `unavailable`. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/health', { headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'unavailable', reason: 'The API could not be reached.' };
  }

  // 200 and 503 both carry a health body; anything else means the API itself is unavailable.
  if (response.status !== 200 && response.status !== 503) {
    return { kind: 'unavailable', reason: 'The server had a problem. Try again in a minute.' };
  }

  const parsed = healthResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { kind: 'unavailable', reason: 'The API returned an unexpected response.' };
  }
  return { kind: parsed.data.status === 'ok' ? 'ok' : 'degraded', health: parsed.data };
}
