import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from 'react-router';
import { ROLE_LABELS } from '@materialmule/shared';
import { EmptyState, PageHeader, StatusBadge } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY } from '../components/useTableView';
import '../settings/settings.css';
import { useMe, useSession } from '../session/context';
import { AuthPage } from './AuthLayout';

/** Signed in but not yet approved: no app data, only a way out (App Idea §8). */
export function AccessPendingPage() {
  const { session, signOut } = useSession();
  if (session.status === 'active') {
    return <Navigate to="/" replace />;
  }
  if (session.status !== 'pending') {
    return <Navigate to="/sign-in" replace />;
  }
  return (
    <AuthPage wide>
      <section className="auth-card" aria-labelledby="access-pending-title">
        <div className="auth-card-head">
          <h1 id="access-pending-title">Access pending</h1>
          <StatusBadge tone="warning">Waiting for approval</StatusBadge>
        </div>
        <p className="auth-callout">
          You’re signed in as <strong>{session.me.displayName}</strong>, but an administrator still
          needs to approve your access. You’ll be able to use Material Mule once they do.
        </p>
        <div className="auth-actions">
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>
      <p className="field-hint">Need access sooner? Ask an administrator.</p>
    </AuthPage>
  );
}

/** Area whose screens arrive with a later card. */
export function PlaceholderPage({ title, card }: { title: string; card: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState>This area arrives with {card}.</EmptyState>
    </>
  );
}

interface SettingsItem {
  to: string;
  label: string;
  /** Mono note on the phone list (e.g. the person's name on My profile). */
  note?: string;
  /** Heavier pages are edited on a computer: left off the phone list (a direct URL still works). */
  desktopOnly?: boolean;
}

/**
 * Field Ledger settings frame (docs/redesign/design.md, "Settings pages"): the grouped list on
 * the left (You, Lab, Tests and reports, System) and the chosen page on the right. Items a person
 * may not manage are hidden; the server still refuses every write and each page says who can
 * change it. On a phone `/settings` is the grouped list alone; the other pages keep the list as
 * one scrolling row above the page.
 */
export function SettingsLayout() {
  const me = useMe();
  const { signOut } = useSession();
  const location = useLocation();
  const phone = useMediaQuery(PHONE_QUERY);
  const can = (permission: string) => me.permissions.includes(permission);
  const roleNote = me.roles.length
    ? me.roles.map((role) => ROLE_LABELS[role]).join(', ')
    : undefined;

  const groups: { name: string; items: (SettingsItem | false)[] }[] = [
    {
      name: 'You',
      items: [
        { to: '/settings/profile', label: 'My profile', note: me.displayName },
        me.accountType !== 'shared_lab' && {
          to: '/settings/access',
          label: 'My access',
          note: roleNote,
        },
      ],
    },
    {
      name: 'Lab',
      items: [
        // MTR-88 / MISC-05: admins only; a direct URL still gets StaffPage's refusal.
        can('staff.manage') && { to: '/settings/staff', label: 'Staff & access' },
        // MISC-04 (Kyle 2026-10-30): everyone keeps a print-only Locations view; only Lab
        // Managers and admins (location.manage) see its add, edit and retire controls.
        { to: '/settings/locations', label: 'Locations' },
        // MM-V2-C27: everyone reads the equipment register; Lab Managers change it.
        { to: '/settings/equipment', label: 'Equipment' },
        // MM-V2-C37: everyone reads them; Lab Managers and admins change suppliers, admins
        // the holiday calendar.
        { to: '/settings/suppliers', label: 'Suppliers' },
        { to: '/settings/holidays', label: 'Holidays', desktopOnly: true },
      ],
    },
    {
      name: 'Tests and reports',
      items: [
        // MISC-04: Tests and Templates are for Lab Managers and admins only.
        can('test_catalog.manage') && { to: '/settings/tests', label: 'Tests', desktopOnly: true },
        can('test_catalog.manage') && {
          to: '/settings/templates',
          label: 'Templates',
          desktopOnly: true,
        },
        // MM-V2-C32: everyone reads it; admins change it.
        { to: '/settings/report-header', label: 'Report header', desktopOnly: true },
      ],
    },
    {
      name: 'System',
      items: [
        can('printer.manage') && { to: '/settings/printers', label: 'Printers' },
        can('settings.drafts.manage') && { to: '/settings/receiving', label: 'Receiving' },
        can('system.status.read') && { to: '/settings/system-status', label: 'System status' },
      ],
    },
  ];
  const shown = groups
    .map((group) => ({
      name: group.name,
      items: group.items.filter(
        (item): item is SettingsItem => item !== false && !(phone && item.desktopOnly),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const phoneList = phone && location.pathname.replace(/\/+$/, '') === '/settings';

  return (
    <>
      <PageHeader title="Settings" documentTitle={false} />
      <div className={phoneList ? 'settings-frame settings-frame-list' : 'settings-frame'}>
        <nav
          className={phone && !phoneList ? 'settings-nav settings-nav-row' : 'settings-nav'}
          aria-label="Settings"
        >
          {shown.map((group) => (
            <div
              key={group.name}
              className="settings-nav-group"
              role="group"
              aria-label={group.name}
            >
              <p className="settings-nav-group-name" aria-hidden="true">
                {group.name}
              </p>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to}>
                  <span className="settings-nav-label">{item.label}</span>
                  {phoneList && item.note ? (
                    <span className="settings-nav-note">{item.note}</span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {phoneList ? (
          <>
            <div className="settings-nav settings-nav-help">
              <div className="settings-nav-group" role="group" aria-label="Help">
                <p className="settings-nav-group-name" aria-hidden="true">
                  Help
                </p>
                <Link to="/help">Help &amp; Feedback</Link>
                <button
                  type="button"
                  className="settings-nav-signout"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </div>
            </div>
            <p className="field-hint">
              Tests, templates, the report header and holidays are edited on a computer.
            </p>
          </>
        ) : (
          <div className="settings-content">
            <Outlet />
          </div>
        )}
      </div>
    </>
  );
}

export function NotFoundPage() {
  const location = useLocation();
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        Nothing lives at <code>{location.pathname}</code>. <Link to="/">Go to the dashboard</Link>.
      </p>
    </>
  );
}

/** Router-level error boundary: a readable message instead of a blank page. */
export function ErrorPage() {
  const error = useRouteError();
  const message =
    isRouteErrorResponse(error) && error.status === 404
      ? 'This page doesn’t exist. Check the address, or go back to the dashboard.'
      : 'Something went wrong while showing this page. Reload to try again.';
  return (
    <main className="shell" role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <p>
        <a href="/">Reload Material Mule</a>
      </p>
    </main>
  );
}

/** Guards app routes: signed-out users go to sign-in (and come back), pending users wait. */
export function RequireActiveSession() {
  const { session } = useSession();
  const location = useLocation();
  if (session.status === 'loading') {
    return (
      <p className="shell" aria-busy="true">
        Loading…
      </p>
    );
  }
  if (session.status === 'error') {
    return (
      <main className="shell" role="alert">
        <h1>Material Mule is unavailable</h1>
        <p>{session.message}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
  if (session.status === 'signed-out') {
    const returnTo = `${location.pathname}${location.search}`;
    const expired = returnTo !== '/' ? '&expired=1' : '';
    return <Navigate to={`/sign-in?returnTo=${encodeURIComponent(returnTo)}${expired}`} replace />;
  }
  if (session.status === 'pending') {
    return <Navigate to="/access-pending" replace />;
  }
  // A different account is a session boundary (shared browsers, a sign-in in another tab found
  // by the focus re-check): remount everything under the guard so no page keeps the previous
  // account's data, form state or late answers. The same account refreshing its roles keeps it.
  return <Outlet key={session.me.id} />;
}
