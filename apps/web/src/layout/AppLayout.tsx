import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { ActionRequestsBell } from '../action-requests/ActionRequestsBell';
import { StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useMe, useSession } from '../session/context';
import { DonkeyMark } from './DonkeyMark';
import { accountBadge, visibleNavItems } from './nav';
import { NavIcon } from './NavIcon';

export function AppLayout() {
  const me = useMe();
  const { signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const badge = accountBadge(me);

  return (
    <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <button
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
        {me.permissions.includes('action_item.read') ? <ActionRequestsBell /> : null}
        <div className="identity" aria-label="Signed in user">
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
      </header>
      <nav id="side-nav" className="side-nav" aria-label="Main">
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
      </nav>
      <main id="main" className="app-main" tabIndex={-1}>
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
