import { useEffect } from 'react';

/**
 * A page that keeps unsaved work and has its own "sign in to continue" prompt (the receiving
 * wizard's saved draft, MM-T11) can claim a background session expiry: when the focus or 403
 * re-check (MTR-11), or an API call, finds the session gone, the claiming page is told instead of
 * the app redirecting to sign-in at once. The page shows its prompt, and its Sign in action then
 * calls refresh(), which finds the session gone and goes to sign-in and back. The server still
 * refuses every request without a session; this only decides when the browser leaves the page.
 */
type Claim = () => void;

const claims = new Set<Claim>();

/** Hands an expiry to the claiming pages; false when no page has claimed one. */
export function claimExpiry(): boolean {
  if (claims.size === 0) return false;
  for (const claim of claims) claim();
  return true;
}

/**
 * While `active`, a background expiry calls `onExpired` instead of redirecting to sign-in.
 * Pass a stable callback (a state setter or useCallback).
 */
export function useExpiryClaim(active: boolean, onExpired: () => void): void {
  useEffect(() => {
    if (!active) return;
    const claim: Claim = () => onExpired();
    claims.add(claim);
    return () => {
      claims.delete(claim);
    };
  }, [active, onExpired]);
}
