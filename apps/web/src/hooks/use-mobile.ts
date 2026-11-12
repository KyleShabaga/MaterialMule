import { useMediaQuery } from '@/components/useMediaQuery';

const MOBILE_BREAKPOINT = 768;

/** Under 768 px the sidebar is a Sheet (shadcn). Uses the app's media-query hook, no effect. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
