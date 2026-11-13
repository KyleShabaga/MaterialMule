import { ArrowUpRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, type Location } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { usePageTitle } from '../../layout/page-title';
import { useMe } from '../../session/context';
import { SettingsPanelFor } from './panels';
import {
  canOpenSection,
  findSection,
  matchesSearch,
  readLastSection,
  SETTINGS_GROUP_LABELS,
  SETTINGS_SECTIONS,
  writeLastSection,
  type SettingsGroupKey,
  type SettingsSection,
} from './registry';

/** Router state when a hidden section was asked for: My access says which (STRATA-100). */
interface BlockedState {
  settingsBlocked?: string;
}

/**
 * The Settings modal (STRATA-28, 100; DESIGN.md › Round 9): 1080 × 680 over the current page,
 * the section nav on the left (only the sections this person can open), the section on the
 * right, scrolling inside. At 1024 px the modal fills the window and the nav narrows; on a phone
 * the nav becomes a row above the section.
 *
 * The address names the section. Switching sections replaces the address, so Back and Close
 * both return to the page behind. Staff, Locations and Lab tests open as full pages (STRATA-128).
 */
export function SettingsModal({
  background,
  canGoBack,
  opener,
}: {
  background: Location | null;
  canGoBack: boolean;
  opener: HTMLElement | null;
}) {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const slug = location.pathname.replace(/^\/settings\/?/, '').split('/')[0] || undefined;
  const requested = findSection(slug);
  const allowed = requested ? canOpenSection(me, requested) : false;
  // A reference section opened by address joins the nav while it is open.
  const sections = useMemo(
    () =>
      SETTINGS_SECTIONS.filter(
        (section) => section.visible(me) || (section === requested && allowed),
      ),
    [me, requested, allowed],
  );
  const blocked = (location.state as BlockedState | null)?.settingsBlocked;
  usePageTitle(requested && allowed ? `${requested.label} · Settings` : 'Settings');

  useEffect(() => {
    if (requested && allowed && !requested.page) writeLastSection(requested.slug);
  }, [requested, allowed]);

  const keepState = { replace: true, state: location.state } as const;

  // `/settings`: the last section visited, if it is still one this person sees.
  if (!slug) {
    const last = findSection(readLastSection());
    const target = last && last.visible(me) && !last.page ? last.slug : 'profile';
    return <Navigate to={`/settings/${target}`} {...keepState} />;
  }
  // An unknown address: Profile.
  if (!requested) return <Navigate to="/settings/profile" {...keepState} />;
  // A hidden section has no page: My access, with a notice (round 9, R9TechBlocked).
  if (!allowed) {
    return (
      <Navigate
        to="/settings/access"
        replace
        state={{ ...(location.state as object | null), settingsBlocked: requested.label }}
      />
    );
  }
  // Staff, Locations and Lab tests are full pages under Lab admin.
  if (requested.page) return <Navigate to={requested.page} replace />;

  const close = () => {
    if (canGoBack) navigate(-1);
    else if (background) {
      navigate(`${background.pathname}${background.search}${background.hash}`, {
        replace: true,
        state: background.state,
      });
    } else navigate('/', { replace: true });
  };

  const choose = (section: SettingsSection) => {
    if (section.page) navigate(section.page, { replace: true });
    else navigate(`/settings/${section.slug}`, keepWithoutBlocked(location.state));
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // The page behind gets its focus back once it is showing again.
          event.preventDefault();
          if (opener) requestAnimationFrame(() => opener.isConnected && opener.focus());
        }}
        className={cn(
          'flex gap-0 overflow-hidden p-0 sm:max-w-none',
          'h-[min(680px,calc(100dvh-2rem))] w-[min(1080px,calc(100vw-2rem))] max-w-none rounded-xl',
          'max-md:h-dvh max-md:w-screen max-md:flex-col max-md:rounded-none',
        )}
      >
        <SettingsNav
          sections={sections}
          current={requested.slug}
          name={me.displayName}
          userId={me.accountType === 'shared_lab' ? null : me.id}
          onChoose={choose}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <SettingsPanelFor slug={requested.slug} blockedSection={blocked} />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close settings"
          title="Close (Esc)"
          className="absolute top-4 right-4 z-30"
          onClick={close}
        >
          <X aria-hidden="true" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function keepWithoutBlocked(state: unknown) {
  const next = { ...((state as Record<string, unknown> | null) ?? {}) };
  delete next.settingsBlocked;
  return { replace: true, state: next } as const;
}

const GROUP_ORDER: SettingsGroupKey[] = ['account', 'lab', 'concrete', 'system'];

function SettingsNav({
  sections,
  current,
  name,
  userId,
  onChoose,
}: {
  sections: SettingsSection[];
  current: string;
  name: string;
  userId: string | null;
  onChoose: (section: SettingsSection) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = sections.filter((section) => matchesSearch(section, query));

  return (
    <nav
      aria-label="Settings"
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        'w-60 max-[1100px]:w-48',
        'max-md:max-h-48 max-md:w-full max-md:border-r-0 max-md:border-b',
      )}
    >
      <DialogTitle className="sr-only">Settings</DialogTitle>
      <div className="p-2 pr-12 md:pr-2">
        <InputGroup className="h-9 rounded-full bg-background">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>
      {shown.length === 0 ? (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          No settings match “{query}”.
        </p>
      ) : null}
      {GROUP_ORDER.map((group) => {
        const items = shown.filter((section) => section.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="px-2 py-1">
            <h3 className="flex h-8 items-center px-2 text-[13px] font-medium text-sidebar-foreground/70">
              {SETTINGS_GROUP_LABELS[group]}
            </h3>
            <ul className="flex flex-col">
              {items.map((section) => (
                <li key={section.slug}>
                  <NavItem
                    section={section}
                    current={section.slug === current}
                    onChoose={onChoose}
                    leading={
                      section.slug === 'profile' ? (
                        <PersonAvatar userId={userId} name={name} size="compact" />
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NavItem({
  section,
  current,
  onChoose,
  leading,
}: {
  section: SettingsSection;
  current: boolean;
  onChoose: (section: SettingsSection) => void;
  leading?: ReactNode;
}) {
  const Icon = section.icon;
  const href = section.page ?? `/settings/${section.slug}`;
  return (
    <a
      data-slot="settings-nav-item"
      href={href}
      aria-current={current ? 'page' : undefined}
      title={section.page ? 'Opens as a page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onChoose(section);
      }}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md p-2 text-sm outline-hidden ring-sidebar-ring focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        current
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      )}
    >
      {leading ?? <Icon aria-hidden="true" />}
      <span className="truncate">{section.label}</span>
      {section.page ? (
        <>
          <ArrowUpRight aria-hidden="true" className="ml-auto text-muted-foreground" />
          <span className="sr-only"> (opens as a page)</span>
        </>
      ) : null}
    </a>
  );
}
