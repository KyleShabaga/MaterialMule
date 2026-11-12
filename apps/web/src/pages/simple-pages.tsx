import { profileResponseSchema, ROLE_LABELS } from '@materialmule/shared';
import {
  House,
  LogOut,
  RefreshCw,
  RotateCw,
  Search,
  ServerOff,
  ShieldCheck,
  Signpost,
  Timer,
  TriangleAlert,
  UserRoundCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState, PageHeader } from '../components/app-ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { PHONE_QUERY } from '../components/useTableView';
import { usePageTitle } from '../layout/page-title';
import { useCommandMenu, type CommandMenuController } from '../search/command-menu';
import '../settings/settings.css';
import { useMe, useSession, useUnavailableRetry, type SessionState } from '../session/context';
import { SignInCardHeading, SignInLayout } from './AuthLayout';

/** How often Waiting for approval asks again whether the account has been approved. */
export const ACCESS_PENDING_POLL_MS = 60_000;

/** Who approves new people (round 9 and 10: Settings › Staff › Pending). */
export const APPROVER_LINE = 'An administrator, in Settings, Staff, Pending.';

const OWN_EMAIL = profileResponseSchema.pick({ workEmail: true, signInUsername: true });

/** The sign-in email of the waiting person, when the profile can be read (pending may read it). */
function useOwnEmail(enabled: boolean): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void fetch('/api/me/profile', { headers: { accept: 'application/json' } })
      .then(async (response) =>
        response.ok ? (OWN_EMAIL.safeParse(await response.json()).data ?? null) : null,
      )
      .then(
        (profile) => {
          if (active && profile) setEmail(profile.workEmail ?? profile.signInUsername ?? null);
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [enabled]);
  return email;
}

/**
 * Waiting for approval (`/access-pending`, round 10): signed in but not approved, so no app data;
 * who is signed in, who approves and a way out. The page asks again every minute and on Check
 * again; once approved the session turns active and the page opens the app by itself. It never
 * shows when the session ends (D38).
 */
export function AccessPendingPage() {
  const { session, signOut, refresh } = useSession();
  const [checking, setChecking] = useState(false);
  const [checkedStill, setCheckedStill] = useState(false);
  const pending = session.status === 'pending';
  const email = useOwnEmail(pending);

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
  const me = session.me;

  async function checkAgain() {
    setChecking(true);
    setCheckedStill(false);
    try {
      await refresh();
      // Still here after the answer: the account is still waiting.
      setCheckedStill(true);
    } finally {
      setChecking(false);
    }
  }

  return (
    <SignInLayout>
      <section aria-labelledby="pending-title" className="flex flex-col gap-6">
        <SignInCardHeading
          id="pending-title"
          icon={UserRoundCheck}
          tone="due"
          title="You are signed in, but not set up yet."
        >
          Your Microsoft sign-in worked. Someone in the office still has to give you access to
          Material Mule.
        </SignInCardHeading>
        <Badge variant="due">Waiting for approval</Badge>
        <dl className="grid gap-3 text-sm">
          <div className="grid gap-1">
            <dt className="text-[13px] text-muted-foreground">Signed in as</dt>
            <dd className="flex min-w-0 items-center gap-3 rounded-lg bg-muted px-3 py-2.5">
              <Avatar className="size-8" aria-hidden="true">
                <AvatarFallback className="bg-background font-mono text-[13px] font-bold">
                  {me.initials ?? initialsOf(me.displayName)}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 leading-tight">
                <span className="truncate font-medium" title={me.displayName}>
                  {me.displayName}
                </span>
                {email ? (
                  <span
                    className="truncate font-mono text-[13px] text-muted-foreground"
                    title={email}
                  >
                    {email}
                  </span>
                ) : null}
              </span>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-[13px] text-muted-foreground">Who approves</dt>
            <dd>{APPROVER_LINE}</dd>
          </div>
        </dl>
        <p className="flex items-start gap-2 text-sm">
          <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>This page opens the app by itself once you are approved.</span>
        </p>
        {checkedStill ? (
          <p
            role="status"
            className="rounded-md bg-muted px-3 py-2 text-[13px] text-muted-foreground"
          >
            Checked just now. Still waiting for approval.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="w-full"
            disabled={checking}
            onClick={() => void checkAgain()}
          >
            {checking ? (
              <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
            ) : (
              <RotateCw aria-hidden="true" />
            )}
            {checking ? 'Checking…' : 'Check again'}
          </Button>
          <Button size="lg" variant="outline" className="w-full" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </section>
    </SignInLayout>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
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
                <Link to="/help" state={{ from: location.pathname }}>
                  Help &amp; Feedback
                </Link>
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

/** The Ctrl K menu when the shell provides one (Page not found also renders outside it in tests). */
function useOptionalCommandMenu(): CommandMenuController | null {
  try {
    return useCommandMenu();
  } catch {
    return null;
  }
}

/**
 * Page not found (round 10), inside the shell: the sidebar and top bar stay. One sentence, the
 * address that wasn't found, Go to Today and Search (Ctrl K). A record that doesn't exist (a unit,
 * a project) uses its own not-found state instead.
 */
export function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const menu = useOptionalCommandMenu();
  usePageTitle('Page not found');
  const address = `${location.pathname}${location.search}`;

  return (
    <Empty className="min-h-[60vh] flex-1">
      <EmptyHeader className="max-w-[440px]">
        <EmptyMedia variant="icon">
          <Signpost aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1 className="text-2xl font-semibold">This page doesn’t exist.</h1>
        </EmptyTitle>
        <EmptyDescription>Check the address, or go back to Today.</EmptyDescription>
        <p
          className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-[13px]"
          title={address}
        >
          {address}
        </p>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <Button asChild>
          <Link to="/">
            <House aria-hidden="true" />
            Go to Today
          </Link>
        </Button>
        <Button
          variant="outline"
          aria-keyshortcuts="Control+K"
          onClick={() => (menu ? menu.open() : void navigate('/search'))}
        >
          <Search aria-hidden="true" />
          Search
          <Kbd aria-hidden="true">Ctrl K</Kbd>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** The crash message inside the shell (round 10): the rest of the app keeps working. */
function CrashContent() {
  return (
    <Empty role="alert" className="min-h-[60vh] flex-1">
      <EmptyHeader className="max-w-[520px]">
        <EmptyMedia variant="icon" className="bg-stage-danger-bg text-stage-danger-fg">
          <TriangleAlert aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h1 className="text-2xl font-semibold">Something went wrong while showing this page.</h1>
        </EmptyTitle>
        <EmptyDescription>
          The rest of Material Mule keeps working. Reload this page, or go back to Today. Anything
          already saved is kept.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCw aria-hidden="true" />
            Reload
          </Button>
          <Button asChild variant="outline">
            <Link to="/" reloadDocument>
              <House aria-hidden="true" />
              Go to Today
            </Link>
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">
          If it happens again, tell your Lab Manager.
        </p>
      </EmptyContent>
    </Empty>
  );
}

/**
 * Route error boundary. With `inShell`, it renders in the shell's content area (a pathless route
 * under AppLayout), so the sidebar and top bar keep working; at the root it uses the sign-in
 * layout. Never shows the error itself: no messages, codes or stack traces.
 */
export function ErrorPage({ inShell = false }: { inShell?: boolean }) {
  const error = useRouteError();
  usePageTitle(
    isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : 'Something went wrong',
  );
  if (isRouteErrorResponse(error) && error.status === 404) {
    return inShell ? (
      <NotFoundPage />
    ) : (
      <SignInLayout>
        <SignInCardHeading id="error-title" icon={Signpost} title="This page doesn’t exist.">
          Check the address, or go back to Today.
        </SignInCardHeading>
        <Button asChild size="lg" className="w-full">
          <Link to="/" reloadDocument>
            <House aria-hidden="true" />
            Go to Today
          </Link>
        </Button>
      </SignInLayout>
    );
  }
  if (inShell) return <CrashContent />;
  return (
    <SignInLayout>
      <section role="alert" aria-labelledby="error-title" className="flex flex-col gap-6">
        <SignInCardHeading
          id="error-title"
          icon={TriangleAlert}
          tone="danger"
          title="Something went wrong while showing this page."
        >
          Reload this page, or go back to Today. Anything already saved is kept.
        </SignInCardHeading>
        <div className="flex flex-col gap-2">
          <Button size="lg" className="w-full" onClick={() => window.location.reload()}>
            <RotateCw aria-hidden="true" />
            Reload
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full">
            <Link to="/" reloadDocument>
              <House aria-hidden="true" />
              Go to Today
            </Link>
          </Button>
        </div>
      </section>
    </SignInLayout>
  );
}

/** Why the server can't be used, in one plain sentence (no codes or technical detail). */
function unavailableReason(state: Extract<SessionState, { status: 'error' }>): string {
  switch (state.kind) {
    case 'server':
      return 'The Material Mule server in the office answered with a problem. It may be restarting.';
    case 'unreadable':
      return 'The Material Mule server sent an answer this computer couldn’t read. It may be restarting.';
    default:
      return 'This computer can’t reach the Material Mule server in the office. The server may be restarting, or this computer may be off the office network.';
  }
}

/**
 * Material Mule is unavailable (round 10): the session couldn't be loaded. It says what happened,
 * that work on this computer is kept (draft receipts and queued moves live in this browser and are
 * never cleared here), and tries again by itself after 5, 10 and 20 seconds, then every 30 seconds
 * (SessionProvider). Try again tries at once.
 */
export function UnavailablePage({ state }: { state: Extract<SessionState, { status: 'error' }> }) {
  const { refresh } = useSession();
  const retry = useUnavailableRetry();
  const [manualTrying, setManualTrying] = useState(false);
  const trying = retry ? retry.trying : manualTrying;
  usePageTitle('Material Mule is unavailable');

  function tryAgain() {
    if (retry) {
      retry.retryNow();
      return;
    }
    setManualTrying(true);
    void refresh().finally(() => setManualTrying(false));
  }

  const seconds = retry ? Math.round(retry.nextDelayMs / 1000) : null;
  return (
    <SignInLayout help={false}>
      <section aria-labelledby="unavailable-title" className="flex flex-col gap-6">
        <div role="alert">
          <SignInCardHeading
            id="unavailable-title"
            icon={ServerOff}
            tone="danger"
            title="Material Mule is unavailable"
          >
            {unavailableReason(state)}
          </SignInCardHeading>
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4 text-stage-storage-mark" aria-hidden="true" />
            Your work on this computer is kept.
          </p>
          <p className="pl-6 text-[13px] text-muted-foreground">
            Draft receipts and moves waiting to be sent stay on this computer until the server is
            back. Keep this window open.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <Button size="lg" className="w-full" disabled={trying} onClick={tryAgain}>
            {trying ? (
              <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
            ) : (
              <RotateCw aria-hidden="true" />
            )}
            {trying ? 'Trying again…' : 'Try again'}
          </Button>
          {seconds !== null ? (
            <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Timer className="size-4" aria-hidden="true" />
              {trying ? 'Trying again…' : `Trying again by itself in ${seconds} seconds.`}
            </p>
          ) : null}
          <p className="text-[13px] text-muted-foreground">
            If it stays unavailable, tell your Lab Manager.
          </p>
        </div>
      </section>
    </SignInLayout>
  );
}

/** Guards app routes: signed-out users go to sign-in (and come back), pending users wait. */
export function RequireActiveSession() {
  const { session } = useSession();
  const location = useLocation();
  if (session.status === 'loading') {
    return (
      <p
        className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground"
        aria-busy="true"
      >
        <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
        Loading…
      </p>
    );
  }
  if (session.status === 'error') {
    return <UnavailablePage state={session} />;
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
