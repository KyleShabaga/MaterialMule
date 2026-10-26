import { CSRF_HEADER_NAME } from '@trapezoid/shared';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * fetch() for the Trapezoid API: same-origin cookies, JSON accept header, and the CSRF header the
 * server requires on every state-changing request (TRP-T04).
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    headers.set(CSRF_HEADER_NAME, '1');
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(path, { ...init, method, headers, credentials: 'same-origin' });
}
