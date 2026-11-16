import { useContext, useRef, type ReactNode } from 'react';
import { UNSAFE_LocationContext, useLocation, useOutlet, type Location } from 'react-router';
import { SettingsModal } from './SettingsModal';
import { isSettingsPath } from './registry';

interface Background {
  outlet: ReactNode;
  locationContext: React.ContextType<typeof UNSAFE_LocationContext>;
  /** How the app arrived at Settings from this page: a push can go Back to it. */
  enteredBy: 'PUSH' | 'REPLACE' | 'POP' | null;
  /** What had focus when Settings opened, given back on close (STRATA-28). */
  opener: HTMLElement | null;
}

/**
 * The shell's page outlet, with Settings as a modal over the page you were on (STRATA-28, 100).
 *
 * Each section has its own address (`/settings/staff`), so the router matches the settings route
 * while the modal is open. To keep the page behind exactly as it was (its scroll, filters, a
 * half-typed field), the outlet keeps rendering that page's last element, with that page's own
 * location in context, until Settings closes. Back, Esc and Close return to it unchanged.
 *
 * A fresh load of a `/settings/*` address has no page behind it: the settings route's own
 * element (Today) is the fallback, and Close goes to Today.
 */
/* eslint-disable react-hooks/refs -- the page behind is captured during render on purpose: the
   render that opens Settings must already show the previous page's element, unchanged, so React
   keeps its state. A state update or effect would show the fallback for one frame first. */
export function SettingsOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  const locationContext = useContext(UNSAFE_LocationContext);
  const background = useRef<Background | null>(null);
  const open = isSettingsPath(location.pathname);

  if (!open) {
    background.current = { outlet, locationContext, enteredBy: null, opener: null };
  } else if (background.current && background.current.enteredBy === null) {
    background.current.enteredBy = locationContext.navigationType;
    background.current.opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  const behind = open && background.current ? background.current : null;
  return (
    <>
      <UNSAFE_LocationContext.Provider value={behind ? behind.locationContext : locationContext}>
        {behind ? behind.outlet : outlet}
      </UNSAFE_LocationContext.Provider>
      {open ? (
        <SettingsModal
          background={behind ? (behind.locationContext.location as Location) : null}
          canGoBack={behind?.enteredBy === 'PUSH'}
          opener={behind?.opener ?? null}
        />
      ) : null}
    </>
  );
}
/* eslint-enable react-hooks/refs */
