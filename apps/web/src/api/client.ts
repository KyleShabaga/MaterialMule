import { CSRF_HEADER_NAME } from '@trapezoid/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Fired when any API call reports the session is gone, so the app can send the user to sign in. */
export const UNAUTHENTICATED_EVENT = 'trapezoid:unauthenticated';

/**
 * fetch() for the Trapezoid API: same-origin cookies, JSON accept header, and the CSRF header the
 * server requires on every state-changing request (TRP-T04). A 401 also fires
 * UNAUTHENTICATED_EVENT (which sends the user to sign in) unless `reportUnauthenticated` is false,
 * for screens that keep the user in place and offer Sign in themselves (TRP-T11 receiving).
 * Callers always get the response.
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
  return response;
}
