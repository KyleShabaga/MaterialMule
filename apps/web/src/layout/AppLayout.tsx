import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { useMediaQuery } from '../components/useMediaQuery';
import { HelpDrawerSlot } from '../help/help-drawer';
import { ShellOverlayProviders } from '../help/shell-providers';
import { NotificationsBell } from '../notifications/NotificationsBell';
import { QuickActions } from '../search/QuickActions';
import { RecordingAsChip } from '../session/recording-person';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { useMe } from '../session/context';
import { AppSidebar } from './AppSidebar';
import { sidebarNavFor } from './nav';
import { useTopBarTitle } from './page-title';
import {
  createSidebarPrefsSource,
  readCollapsed,
  useSidebarPrefs,
  writeCollapsed,
} from './sidebar-prefs';
import { useFocusPageHeading } from './useFocusPageHeading';
import { SettingsOutlet } from '../settings/modal/SettingsOutlet';
import './shell.css';

/** Phone width (pages' own phone layouts, e.g. Today). The sidebar's Sheet starts below 768 px. */
export const PHONE_QUERY = '(max-width: 640px)';

/** Below 1280 px the sidebar starts collapsed to icons, so work tables get the width. */
export const NARROW_DESKTOP_QUERY = '(max-width: 1279px)';

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

/** Any navigation closes the phone Sheet (a link inside it was followed, or Back). */
function CloseSheetOnNavigate() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

/**
 * STRATA-12 top bar, 56 px: the sidebar toggle and the page's name at the left; at the right,
 * 8 px apart, Recording as (LAB stations), Quick actions and, always last, the bell. The name is
 * text, not a heading: each page keeps its own h1 (DESIGN.md, "One h1 per page").
 */
function TopBar() {
  const me = useMe();
  const title = useTopBarTitle();
  // The chip needs the station provider (routes.tsx mounts it); without it there is no station.
  const recording = useOptionalRecordingPerson();
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1 max-md:size-11 pointer-coarse:size-11" />
      <p className="min-w-0 truncate text-sm font-semibold">{title}</p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {recording ? <RecordingAsChip /> : null}
        <QuickActions />
        {/* A LAB station shows the picked person's bell through the consent-based station
            summary only (STRATA-27); LAB itself never holds notification.read. */}
        {me.permissions.includes('notification.read') ? (
          <NotificationsBell />
        ) : recording?.isStation ? (
          // Beside the recording chip the phone top bar has no room: there the station's Inbox
          // is the sidebar row (stations are desktop computers; phones rarely sign in as LAB).
          <div className="contents max-md:hidden">
            <NotificationsBell />
          </div>
        ) : null}
      </div>
    </header>
  );
}

/**
 * Strata shell (DESIGN.md › Shell, › Sidebar; STRATA-8, 9, 12): the shadcn Sidebar (a Sheet under
 * 768 px, opened from the top bar), the top bar and the page. `main#main` keeps its place in the
 * tree at every width, so crossing a breakpoint never remounts the page or loses its input.
 *
 * Collapsed (Ctrl B) is remembered per browser (STRATA-42: localStorage through sidebar-prefs,
 * replacing shadcn's cookie); never chosen, the window decides (collapsed below 1280 px).
 */
export function AppLayout() {
  const me = useMe();
  const recording = useOptionalRecordingPerson();
  useFocusPageHeading();

  // Station: the controller's word (a picked person grants nothing); the account type as fallback.
  const station = recording?.isStation ?? me.accountType === 'shared_lab';
  const personId = station ? (recording?.person?.id ?? null) : null;
  // Pins and recents are the person's own (never on a station).
  const records = !station && me.permissions.includes('personal_settings.manage');
  // Keyed by identity, not by the `me` object: re-reading /api/me keeps the layout on screen.
  const source = useMemo(
    () => createSidebarPrefsSource({ station, personId, records }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new account needs a new source
    [me.id, station, personId, records],
  );
  const prefs = useSidebarPrefs(source);
  const nav = sidebarNavFor(me);

  const narrow = useMediaQuery(NARROW_DESKTOP_QUERY);
  const [collapsed, setCollapsed] = useCollapsed();
  const open = !(collapsed ?? narrow);

  return (
    <ShellOverlayProviders>
      <SidebarProvider open={open} onOpenChange={(next) => setCollapsed(!next)}>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-4 py-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <CloseSheetOnNavigate />
        <AppSidebar nav={nav} prefs={prefs} station={station} />
        <SidebarInset className="min-w-0">
          <TopBar />
          <main id="main" className="app-main" tabIndex={-1}>
            <ProfileNotice />
            <SettingsOutlet />
          </main>
          <HelpDrawerSlot />
        </SidebarInset>
      </SidebarProvider>
    </ShellOverlayProviders>
  );
}

/** The browser's collapsed choice (null: never chosen), saved as it changes. */
function useCollapsed(): [boolean | null, (collapsed: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(readCollapsed);
  const set = (collapsed: boolean) => {
    writeCollapsed(collapsed);
    setValue(collapsed);
  };
  return [value, set];
}
