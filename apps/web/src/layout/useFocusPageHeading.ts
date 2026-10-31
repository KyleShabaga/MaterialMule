import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/** How long to wait for a page that loads its data before it renders its h1. */
const WAIT_MS = 5000;

/**
 * After a route change, moves focus to the new page's h1 (made focusable with tabIndex=-1), so
 * keyboard and screen-reader users land on the page they opened instead of the old menu link or
 * the page body (MTR-136). The first page load keeps the browser's own focus, and a page that
 * already put focus inside the main area (a scan box, a wizard step) keeps it.
 */
export function useFocusPageHeading() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const main = document.getElementById('main');
    if (!main) return;

    function focusHeading(): boolean {
      const heading = main!.querySelector<HTMLElement>('h1');
      if (!heading) return false;
      const active = document.activeElement;
      if (active && active !== document.body && active !== main && main!.contains(active)) {
        return true;
      }
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      return true;
    }

    if (focusHeading()) return;
    const observer = new MutationObserver(() => {
      if (focusHeading()) stop();
    });
    const timer = setTimeout(stop, WAIT_MS);
    function stop() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(main, { childList: true, subtree: true });
    return stop;
  }, [pathname]);
}
