import { healthResponseSchema } from '@materialmule/shared';
import {
  Bug,
  ChevronsUpDown,
  CircleQuestionMark,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarFooter as SidebarFooterSlot,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useMe, useSession } from '../session/context';
import { clearRecordingPerson } from '../session/recording-person-store';
import { useThemeChoice, type ThemeChoice } from '../theme/theme';
import { accountInitials, accountRowText } from './nav';

const HEALTH_POLL_MS = 60_000;

type Health = 'checking' | 'ok' | 'degraded' | 'unreachable';

const HEALTH_TEXT: Record<Health, string> = {
  checking: 'Checking server…',
  ok: 'Server connected',
  degraded: 'Server connected, database unavailable',
  unreachable: 'Server unreachable',
};

async function checkHealth(): Promise<Health> {
  try {
    const response = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const body = healthResponseSchema.safeParse(await response.json().catch(() => null));
    if (!body.success) return 'unreachable';
    return response.ok && body.data.status === 'ok' ? 'ok' : 'degraded';
  } catch {
    return 'unreachable';
  }
}

/**
 * MISC-09: server health (GET /api/health), every minute and when the window regains focus.
 * Strata: shown above the account row only when something is wrong; while the server is fine
 * the line is for screen readers only (it is still a live region, so recovery is announced).
 */
export function ServerHealth() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void checkHealth().then((next) => {
        if (active) setHealth(next);
      });
    refresh();
    const timer = window.setInterval(refresh, HEALTH_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const problem = health === 'degraded' || health === 'unreachable';
  return (
    // aria-live rather than role=status: pages keep their one status region for their own notices.
    <p
      className={cn(
        'server-health flex items-center gap-2 px-2 text-[13px] text-destructive-text group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0',
        !problem && 'sr-only',
      )}
      data-health={health}
      aria-live="polite"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
      <span className="group-data-[collapsible=icon]:sr-only">{HEALTH_TEXT[health]}</span>
    </p>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** STRATA-7: Light / Dark / System, saved per browser; System follows the operating system. */
function ThemeChoiceItems() {
  const [choice, setChoice] = useThemeChoice();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">
        Theme
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={choice}
        onValueChange={(value) => setChoice(value as ThemeChoice)}
      >
        {THEMES.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            // Keep the menu open, so the change can be seen and undone.
            onSelect={(event) => event.preventDefault()}
          >
            <Icon aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/**
 * STRATA-15 (finishes STRATA-7): the account row and its menu. Personal: Theme, Settings, Help,
 * Feedback & bugs, Sign out. Shared LAB station: Settings, Help, Feedback & bugs and End station
 * session (signs the station out). Signing off the picked person is the Recording as chip's,
 * never this menu's. No session end time (D38 is deferred).
 */
export function AccountMenu() {
  const me = useMe();
  const { signOut } = useSession();
  const { pathname } = useLocation();
  const station = me.accountType === 'shared_lab';
  const { name, line } = accountRowText(me);
  const initials = station ? 'LAB' : accountInitials(me);
  // Help's "Include the page I was on" offers the path the menu was used from.
  const helpState = pathname === '/help' ? undefined : { from: pathname };

  const avatar = (
    <Avatar aria-hidden="true" className={cn('size-8', station && 'rounded-md')}>
      <AvatarFallback
        className={cn(
          'font-mono text-[13px] font-bold',
          station
            ? 'rounded-md bg-sidebar-primary text-[11px] text-sidebar-primary-foreground'
            : 'bg-accent text-accent-foreground',
        )}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
  const lines = (
    <span className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
      <span className="flex items-center gap-1.5">
        <span className="truncate font-semibold">{name}</span>
        {me.accountType === 'test' ? (
          <Badge variant="outline" className="px-1.5 font-mono text-[11px]">
            TEST
          </Badge>
        ) : null}
      </span>
      <span className="truncate text-[13px] text-muted-foreground">{line}</span>
    </span>
  );

  return (
    <div role="group" aria-label="Signed in user">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                aria-label={`${name}, ${line}. Account menu`}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                {avatar}
                {lines}
                <ChevronsUpDown
                  aria-hidden="true"
                  className="ml-auto group-data-[collapsible=icon]:hidden"
                />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={4} className="w-60">
              {station ? null : (
                <>
                  <DropdownMenuLabel className="p-0 font-normal">
                    <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                      {avatar}
                      <span className="grid flex-1 leading-tight">
                        <span className="truncate font-semibold">{name}</span>
                        <span className="truncate text-[13px] text-muted-foreground">{line}</span>
                      </span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <ThemeChoiceItems />
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <Link to="/settings">
                    <Settings aria-hidden="true" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/help" state={helpState}>
                    <CircleQuestionMark aria-hidden="true" />
                    Help
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  {/* The feedback form is on the Help page until its dialog (STRATA-104). */}
                  <Link to="/help" state={helpState}>
                    <Bug aria-hidden="true" />
                    Feedback &amp; bugs
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  // Ending the station session also forgets who was working here.
                  if (station) clearRecordingPerson();
                  void signOut();
                }}
              >
                <LogOut aria-hidden="true" />
                {station ? 'End station session' : 'Sign out'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  );
}

/** Bottom of the sidebar: server health when something is wrong, then the account row. */
export function SidebarFooter() {
  return (
    <SidebarFooterSlot className="gap-1">
      <ServerHealth />
      <AccountMenu />
    </SidebarFooterSlot>
  );
}
