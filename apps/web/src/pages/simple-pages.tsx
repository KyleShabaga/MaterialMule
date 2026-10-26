import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from 'react-router';
import { EmptyState, PageHeader } from '../components/ui';
import { useMe, useSession } from '../session/context';

/** Signed in but not yet approved: no app data, only a way out (App Idea §8). */
export function AccessPendingPage() {
  const { session, signOut } = useSession();
  if (session.status === 'active') {
    return <Navigate to="/" replace />;
  }
  if (session.status !== 'pending') {
    return <Navigate to="/sign-in" replace />;
  }
  if (session.me.positionSetupRequired) {
    return <Navigate to="/onboarding/position" replace />;
  }
  return (
    <main className="shell">
      <h1>Access pending</h1>
      <p>
        You’re signed in as <strong>{session.me.displayName}</strong>, but an administrator still
        needs to approve your access. You’ll be able to use Trapezoid once they do.
      </p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
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

export function SettingsLayout() {
  const me = useMe();
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="sub-nav" aria-label="Settings">
        <NavLink to="/settings/profile">My profile</NavLink>
        <NavLink to="/settings/staff">Staff &amp; access</NavLink>
        <NavLink to="/settings/locations">Locations</NavLink>
        {me.permissions.includes('printer.manage') ? (
          <NavLink to="/settings/printers">Printers</NavLink>
        ) : null}
        {me.permissions.includes('settings.drafts.manage') ? (
          <NavLink to="/settings/receiving">Receiving</NavLink>
        ) : null}
        {me.permissions.includes('system.status.read') ? (
          <NavLink to="/settings/system-status">System status</NavLink>
        ) : null}
      </nav>
      <Outlet />
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
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'Something went wrong while showing this page.';
  return (
    <main className="shell" role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <p>
        <a href="/">Reload Trapezoid</a>
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
        <h1>Trapezoid is unavailable</h1>
        <p>{session.message}</p>
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
  // First-login position setup comes before anything else (TRP-T05).
  if (session.me.positionSetupRequired) {
    return <Navigate to="/onboarding/position" replace />;
  }
  return <Outlet />;
}
