import { FEEDBACK_PAGE_MAX } from '@materialmule/shared';

// "Include the page I was on" (STRATA-104) sends the path only: never the query string or hash
// (searches, IDs, sign-in codes live there), and never a path segment that looks like a token.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A long run of letters and digits (24+ characters, both kinds) that isn't a UUID: an access
 * code, a reset link's secret, a JWT. Record IDs in this app are UUIDs or short readable IDs.
 */
export function isTokenLike(segment: string): boolean {
  if (UUID.test(segment)) return false;
  if (segment.length >= 64) return true;
  return (
    segment.length >= 24 &&
    /^[A-Za-z0-9._~+=-]+$/.test(segment) &&
    /\d/.test(segment) &&
    /[A-Za-z]/.test(segment)
  );
}

/**
 * The in-app path to send with feedback: query string and hash removed, token-like segments
 * replaced by `…`, no whitespace, at most FEEDBACK_PAGE_MAX characters. Null when there is no
 * usable path (it must start with a single "/").
 */
export function feedbackPagePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = raw.split(/[?#]/)[0]!.replace(/\s+/g, '');
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const clean = path
    .split('/')
    .map((segment) => (isTokenLike(segment) ? '…' : segment))
    .join('/');
  return clean.slice(0, FEEDBACK_PAGE_MAX);
}
