import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { ActionRequestsBell } from '../action-requests/ActionRequestsBell';
import { StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { NotificationsBell } from '../notifications/NotificationsBell';
import { useMe, useSession } from '../session/context';
import { DonkeyMark } from './DonkeyMark';
import { accountBadge, visibleNavItems } from './nav';
import { NavIcon } from './NavIcon';
import { SidebarFooter } from './SidebarFooter';
import { useFocusPageHeading } from './useFocusPageHeading';

export function AppLayout() {
  const me = useMe();
  const { signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const badge = accountBadge(me);
  const canSeePending = me.permissions.includes('action_item.read');
  const canSeeNotifications = me.permissions.includes('notification.read');
  useFocusPageHeading();

  // MTR-137: while the phone drawer is open, what it covers is inert; focus starts on the first
  // link, and Escape or a tap outside closes it and returns focus to Menu.
  useEffect(() => {
    if (!menuOpen) return;
    navRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const closeToMenu = () => {
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeToMenu();
      }
    };
    // On click rather than pointerdown, so the tap's own focus change can't undo the return.
    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (navRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      closeToMenu();
    };
    // Widening past phone width hides the drawer; don't leave the page inert behind it.
    const wide = window.matchMedia?.('(min-width: 641px)');
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onOutsideClick, true);
    wide?.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onOutsideClick, true);
      wide?.removeEventListener('change', onWide);
    };
  }, [menuOpen]);

  return (
    <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <button
          ref={menuButtonRef}
          type="button"
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="side-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          Menu
        </button>
        <Link to="/" className="app-brand">
          <span className="app-mark">
            <DonkeyMark />
          </span>
          <span className="app-name">Material Mule</span>
        </Link>
        <div className="identity" aria-label="Signed in user" inert={menuOpen}>
          <span className="identity-name">
            {me.displayName}
            {me.initials ? <span className="identity-initials"> ({me.initials})</span> : null}
          </span>{' '}
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          {me.accountType === 'shared_lab' ? (
            <span className="identity-expiry">
              {' '}
              Session ends{' '}
              <time dateTime={me.sessionExpiresAt}>{formatExpiry(me.sessionExpiresAt)}</time>
            </span>
          ) : null}
          <button type="button" onClick={() => void signOut('/sign-in?switch=1')}>
            Switch user
          </button>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        {/* MISC-02: the header controls sit to the right of the user area. MM-T91: Pending actions
            and Notifications are two separately labelled controls with their own counts. */}
        {canSeePending || canSeeNotifications ? (
          <div className="header-alerts" inert={menuOpen}>
            {canSeePending ? <ActionRequestsBell inert={menuOpen} /> : null}
            {canSeeNotifications ? <NotificationsBell inert={menuOpen} /> : null}
          </div>
        ) : null}
      </header>
      <nav id="side-nav" className="side-nav" aria-label="Main" ref={navRef}>
        <p className="nav-heading">Primary navigation</p>
        <ul>
          {visibleNavItems().map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                // Close the phone drawer once a destination is chosen.
                onClick={() => setMenuOpen(false)}
              >
                <NavIcon to={item.to} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <SidebarFooter />
      </nav>
      <main id="main" className="app-main" tabIndex={-1} inert={menuOpen}>
        {me.profileRefreshFailed ? (
          <p className="notice" role="status">
            Your Microsoft profile couldn’t be refreshed, so your last known details are in use.{' '}
            <Link to="/settings/profile">Review and retry</Link>
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
