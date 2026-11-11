import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError,
} from 'react-router';
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui';
import { usePageTitle } from '../layout/page-title';
import { useMe, useSession } from '../session/context';
import { AuthPage } from './AuthLayout';
import './entry-pages.css';

/** How often Access pending asks again whether the account has been approved. */
export const ACCESS_PENDING_POLL_MS = 60_000;

/**
 * Signed in but not yet approved: no app data, only who approves and a way out (App Idea §8).
 * The page asks again every minute and on Check again; once approved, the session turns active
 * and the page opens the app by itself.
 */
export function AccessPendingPage() {
  const { session, signOut, refresh } = useSession();
  const [checking, setChecking] = useState(false);
  const pending = session.status === 'pending';

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void refresh(), ACCESS_PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  if (session.status === 'active') {
    return <Navigate to="/" replace />;
  }
  if (session.status !== 'pending') {
    return <Navigate to="/sign-in" replace />;
  }

  async function checkAgain() {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthPage
      wide
      headerAction={
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    >
      <span className="auth-pending-tag">
        <StatusBadge tone="waiting">Waiting for approval</StatusBadge>
      </span>
      <h1>You are signed in, but not set up yet.</h1>
      <p className="auth-lead-line">
        An administrator needs to approve your account and give you a role before you can see any
        records.
      </p>
      <dl className="auth-facts">
        <div>
          <dt>Signed in as</dt>
          <dd>{session.me.displayName}</dd>
        </div>
        <div>
          <dt>Who approves</dt>
          <dd>An administrator, in Settings, Staff and access</dd>
        </div>
      </dl>
      <div className="auth-actions">
        <button
          type="button"
          className="primary"
          disabled={checking}
          onClick={() => void checkAgain()}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <span className="auth-hint">This page opens the app by itself once you are approved.</span>
      </div>
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
      <PageHeader title="Settings" documentTitle={false} />
      <nav className="sub-nav" aria-label="Settings">
        <NavLink to="/settings/profile">My profile</NavLink>
        {me.accountType === 'shared_lab' ? null : (
          <NavLink to="/settings/access">My access</NavLink>
        )}
        {/* MTR-88 / MISC-05: admins only; a direct URL still gets StaffPage's refusal. */}
        {me.permissions.includes('staff.manage') ? (
          <NavLink to="/settings/staff">Staff &amp; access</NavLink>
        ) : null}
        {/* MISC-04 (Kyle 2026-10-30): everyone keeps a print-only Locations view; only Lab
            Managers and admins (location.manage) see its add, edit and retire controls. */}
        <NavLink to="/settings/locations">Locations</NavLink>
        {/* MM-V2-C27: everyone reads the equipment register; Lab Managers change it. */}
        <NavLink to="/settings/equipment">Equipment</NavLink>
        {/* MM-V2-C37: everyone reads them; Lab Managers and admins change suppliers, admins
            the holiday calendar. */}
        <NavLink to="/settings/suppliers">Suppliers</NavLink>
        <NavLink to="/settings/holidays">Holidays</NavLink>
        {/* MM-V2-C32: everyone reads it; admins change it. */}
        <NavLink to="/settings/report-header">Report header</NavLink>
        {/* MISC-04: Tests and Templates are for Lab Managers and admins only. */}
        {me.permissions.includes('test_catalog.manage') ? (
          <>
            <NavLink to="/settings/tests">Tests</NavLink>
            <NavLink to="/settings/templates">Templates</NavLink>
          </>
        ) : null}
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

/**
 * Page not found (Field Ledger "NotFound"): one sentence, a field that looks for the record on
 * the search page, and three ways out. The tab title stays "Page not found".
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const fieldId = useId();
  usePageTitle('Page not found');

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (q) void navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="not-found">
      <span className="not-found-tag">
        <StatusBadge tone="closed">Not found</StatusBadge>
      </span>
      <h1 className="not-found-title">Nothing is at this address.</h1>
      <p className="not-found-line">
        The link may be old, or the ID may be mistyped. Unit IDs look like{' '}
        <span className="mono">BKT-2026-000142</span>. No record has been changed.
      </p>
      <form className="not-found-search" role="search" aria-label="Look for it" onSubmit={submit}>
        <label htmlFor={fieldId} className="field-label">
          Look for it
        </label>
        <div className="not-found-search-row">
          <input
            id={fieldId}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={100}
            placeholder="Unit ID, project, test hole or shelf"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="primary">
            Search
          </button>
        </div>
      </form>
      <div className="not-found-ways">
        <Link className="button" to="/">
          Go to Today
        </Link>
        <Link className="button" to="/sample-storage">
          Go to Inventory
        </Link>
        <button type="button" onClick={() => void navigate(-1)}>
          Go back
        </button>
      </div>
    </div>
  );
}

/** Router-level error boundary (States, "Could not load"): what happened and one way on. */
export function ErrorPage() {
  const error = useRouteError();
  const message =
    isRouteErrorResponse(error) && error.status === 404
      ? 'This page doesn’t exist. Check the address, or go back to Today.'
      : 'Something went wrong while showing this page.';
  return (
    <main className="shell error-page">
      <ErrorState
        tag="Not shown"
        message={message}
        detail="Nothing was changed. Reload Material Mule to try again."
        retryLabel="Reload Material Mule"
        onRetry={() => window.location.assign('/')}
      />
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
