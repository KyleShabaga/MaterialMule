import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useMediaQuery } from '../components/useMediaQuery';
import { useMoreCounts, type MoreCounts } from '../dashboard/more-counts';
import { SearchBox } from '../search/SearchBox';
import { NotificationsBell } from '../notifications/NotificationsBell';
import { useMe } from '../session/context';
import { DonkeyMark } from './DonkeyMark';
import {
  activeDestination,
  activeSubPage,
  canUseSearch,
  destinationsFor,
  type Destination,
} from './nav';
import { SidebarFooter } from './SidebarFooter';
import { useFocusPageHeading } from './useFocusPageHeading';
import './shell.css';

/** Phone layout (bottom bar, no rail) up to 640 px, matching shell.css. */
export const PHONE_QUERY = '(max-width: 640px)';

/** Donkey tile and wordmark, linking to Today (38 px tile in the rail, 32 px on a phone). */
function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-tile" aria-hidden="true">
        <DonkeyMark />
      </span>
      <span className="brand-name">Material Mule</span>
    </Link>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="rail-chevron"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * The seven destinations, with the Retention and Concrete groups (drop-downs). A group opens by
 * itself while you are inside its section; its chevron overrides that until the next toggle.
 * Shared by the desktop rail and the phone More sheet.
 */
function DestinationList({
  destinations,
  idPrefix,
  onNavigate,
  counts,
}: {
  destinations: Destination[];
  idPrefix: string;
  onNavigate?: () => void;
  /** Phone More sheet only (canvas PhoneMore): a count per destination; the rail has none. */
  counts?: MoreCounts;
}) {
  const { pathname } = useLocation();
  const active = activeDestination(pathname);
  const [toggled, setToggled] = useState<Partial<Record<string, boolean>>>({});

  return (
    <ul className="rail-list">
      {destinations.map((item) => {
        const current = active === item.key;
        const sub = item.children.length > 0 ? activeSubPage(pathname, item.children) : null;
        const open = item.children.length > 0 && (toggled[item.key] ?? current);
        const groupId = `${idPrefix}-${item.key}`;
        const count = counts?.[item.key];
        const countId = `${idPrefix}-${item.key}-count`;
        return (
          <li key={item.key} className="rail-item">
            <div className={current ? 'rail-row is-current' : 'rail-row'}>
              <Link
                to={item.to}
                className="rail-link"
                // The destination is the current page unless one of its sub-pages is marked.
                aria-current={current ? (sub ? 'true' : 'page') : undefined}
                aria-describedby={count !== undefined ? countId : undefined}
                onClick={onNavigate}
              >
                {item.label}
                {count !== undefined ? (
                  // Out of the link's name (it stays "Inventory"); read as its description.
                  <span id={countId} className="more-count" aria-hidden="true">
                    {count}
                  </span>
                ) : null}
              </Link>
              {item.children.length > 0 ? (
                <button
                  type="button"
                  className="rail-toggle"
                  aria-expanded={open}
                  aria-controls={groupId}
                  aria-label={`${open ? 'Hide' : 'Show'} ${item.label} pages`}
                  onClick={() => setToggled((state) => ({ ...state, [item.key]: !open }))}
                >
                  <Chevron />
                </button>
              ) : null}
            </div>
            {item.children.length > 0 ? (
              <ul
                id={groupId}
                className="rail-sub"
                aria-label={`${item.label} pages`}
                hidden={!open}
              >
                {item.children.map((page) => (
                  <li key={page.to}>
                    <Link
                      to={page.to}
                      className="rail-sub-link"
                      aria-current={sub === page.to ? 'page' : undefined}
                      onClick={onNavigate}
                    >
                      {page.label}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The notification bell (MM-T91): personal accounts only (`notification.read`). */
function Bell({ inert = false }: { inert?: boolean }) {
  const me = useMe();
  if (!me.permissions.includes('notification.read')) return null;
  return <NotificationsBell inert={inert} />;
}

function ProfileNotice() {
  const me = useMe();
  if (!me.profileRefreshFailed) return null;
  return (
    <p className="notice" role="status">
      Your Microsoft profile couldn’t be refreshed, so your last known details are in use.{' '}
      <Link to="/settings/profile">Review and retry</Link>
    </p>
  );
}

/** Destinations the phone bar holds itself; the rest live in the More sheet. */
const BAR_DESTINATIONS = new Set<string>(['today', 'receive']);

/**
 * Field Ledger shell (docs/redesign/design.md): the desktop rail and top bar, or on a phone the
 * header strip, five-slot bottom bar and More sheet. Only one layout's chrome is rendered at a
 * time, so there is always exactly one "Main" navigation. `main` keeps its place in the tree in
 * both, so crossing 640 px (a phone turned sideways) never remounts the page or loses its input.
 */
export function AppLayout() {
  const me = useMe();
  const phone = useMediaQuery(PHONE_QUERY);
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusPageHeading();

  const destinations = destinationsFor(me);
  const active = activeDestination(pathname);
  // Field Ledger search for every session that can read storage units (LAB included).
  const search = canUseSearch(me);
  const sheetOpen = phone && moreOpen;
  const moreCounts = useMoreCounts(sheetOpen, me);

  // Any navigation, or widening past phone width, closes the More sheet.
  const [shownAt, setShownAt] = useState(pathname);
  if (shownAt !== pathname) {
    setShownAt(pathname);
    setMoreOpen(false);
  }
  if (moreOpen && !phone) setMoreOpen(false);

  // MTR-137 (now the More sheet): while it is open, what it covers is inert; focus starts on its
  // first link, and Escape or a tap outside closes it and returns focus to More.
  useEffect(() => {
    if (!sheetOpen) return;
    sheetRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    const closeToMore = () => {
      setMoreOpen(false);
      moreRef.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeToMore();
      }
    };
    // On click rather than pointerdown, so the tap's own focus change can't undo the return.
    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sheetRef.current?.contains(target) || moreRef.current?.contains(target)) return;
      closeToMore();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onOutsideClick, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onOutsideClick, true);
    };
  }, [sheetOpen]);

  const findTo = search ? '/search' : '/sample-storage';
  const slot = (() => {
    if (pathname === '/sample-storage/scan') return 'scan';
    if (active === 'today') return 'today';
    if (active === 'receive') return 'receive';
    if (search ? pathname === '/search' : pathname === '/sample-storage') return 'find';
    if (active !== null) return 'more';
    return null;
  })();
  const close = () => setMoreOpen(false);
  const slotLink = (key: string, to: string, label: string, extra = '') => (
    <li inert={sheetOpen}>
      <Link
        to={to}
        className={`phone-slot ${extra}`.trim()}
        aria-current={slot === key ? 'page' : undefined}
      >
        {label}
      </Link>
    </li>
  );

  return (
    <div className={phone ? `app app-phone${sheetOpen ? ' more-open' : ''}` : 'app'}>
      <a className="skip-link" href="#main" inert={sheetOpen}>
        Skip to content
      </a>
      {phone ? null : (
        <nav className="rail" aria-label="Main">
          <Brand />
          <DestinationList destinations={destinations} idPrefix="rail-group" />
          <SidebarFooter />
        </nav>
      )}
      <div className="app-column">
        {phone ? (
          <header className="phone-header" inert={sheetOpen}>
            <div className="phone-header-row">
              <Brand />
              <Bell inert={sheetOpen} />
            </div>
            {/* Find: the search field sits in the header on its results page (PhoneFind). */}
            {search && pathname === '/search' ? <SearchBox /> : null}
          </header>
        ) : (
          <header className="top-bar">
            {search ? <SearchBox /> : <span className="top-bar-spacer" />}
            <Bell />
          </header>
        )}
        <main id="main" className="app-main" tabIndex={-1} inert={sheetOpen}>
          <ProfileNotice />
          <Outlet />
        </main>
      </div>
      {phone ? (
        <nav className="phone-nav" aria-label="Main">
          {sheetOpen ? (
            <div id="more-sheet" className="more-sheet" ref={sheetRef}>
              <DestinationList
                destinations={destinations.filter((d) => !BAR_DESTINATIONS.has(d.key))}
                idPrefix="more-group"
                onNavigate={close}
                counts={moreCounts}
              />
              <SidebarFooter onNavigate={close} />
            </div>
          ) : null}
          <ul className="phone-bar">
            {slotLink('today', '/', 'Today')}
            {slotLink('find', findTo, 'Find')}
            {slotLink('scan', '/sample-storage/scan', 'Scan', 'phone-slot-scan')}
            {slotLink('receive', '/receiving-log', 'Receive')}
            <li>
              <button
                ref={moreRef}
                type="button"
                className={slot === 'more' ? 'phone-slot is-current' : 'phone-slot'}
                aria-expanded={sheetOpen}
                aria-controls={sheetOpen ? 'more-sheet' : undefined}
                onClick={() => setMoreOpen((open) => !open)}
              >
                More
              </button>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
