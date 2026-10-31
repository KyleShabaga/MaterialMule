import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from 'react-router';
import { EmptyState, PageHeader, StatusBadge } from '../components/ui';
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
  if (session.me.positionSetupRequired) {
    return <Navigate to="/onboarding/position" replace />;
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

export function SettingsLayout() {
  const me = useMe();
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="sub-nav" aria-label="Settings">
        <NavLink to="/settings/profile">My profile</NavLink>
        {me.accountType === 'shared_lab' ? null : (
          <NavLink to="/settings/access">My access</NavLink>
        )}
        {/* MTR-88 / MISC-05: admins only; a direct URL still gets StaffPage's refusal. */}
        {me.permissions.includes('staff.manage') ? (
          <NavLink to="/settings/staff">Staff &amp; access</NavLink>
        ) : null}
        <NavLink to="/settings/locations">Locations</NavLink>
        <NavLink to="/settings/tests">Tests</NavLink>
        <NavLink to="/settings/templates">Templates</NavLink>
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
  // First-login position setup comes before anything else (MM-T05).
  if (session.me.positionSetupRequired) {
    return <Navigate to="/onboarding/position" replace />;
  }
  return <Outlet />;
}
