import { CSRF_HEADER_NAME } from '@materialmule/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Fired when any API call reports the session is gone, so the app can send the user to sign in. */
export const UNAUTHENTICATED_EVENT = 'materialmule:unauthenticated';

/**
 * Fired when an API call is refused with 403 `forbidden`: the caller's roles may have changed
 * since /api/me was loaded, so the session re-reads it and the navigation follows (MTR-11).
 */
export const FORBIDDEN_EVENT = 'materialmule:forbidden';

/**
 * fetch() for the Material Mule API: same-origin cookies, JSON accept header, and the CSRF header the
 * server requires on every state-changing request (MM-T04). A 401 also fires
 * UNAUTHENTICATED_EVENT (which sends the user to sign in) unless `reportUnauthenticated` is false,
 * for screens that keep the user in place and offer Sign in themselves (MM-T11 receiving). A 403
 * with code `forbidden` fires FORBIDDEN_EVENT. Callers always get the response, body unread.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  { reportUnauthenticated = true }: { reportUnauthenticated?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    headers.set(CSRF_HEADER_NAME, '1');
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
  if (response.status === 401 && reportUnauthenticated) {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  }
  if (response.status === 403 && typeof response.clone === 'function') {
    void reportForbidden(response.clone());
  }
  return response;
}

async function reportForbidden(response: Response): Promise<void> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object' && (body as { code?: unknown }).code === 'forbidden') {
    window.dispatchEvent(new Event(FORBIDDEN_EVENT));
  }
}
