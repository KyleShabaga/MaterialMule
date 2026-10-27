import { useCallback, useSyncExternalStore } from 'react';

/** Wider than 1280 CSS pixels, strictly (MM-T66: "above 1280 px"); 1280 itself is not wide. */
export const WIDE_SCREEN = '(width > 1280px)';

/**
 * Whether a media query matches now, updated as the window is resized. False where matchMedia
 * doesn't exist (tests, very old browsers), so the narrower layout is the safe default.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
