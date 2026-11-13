import {
  ChevronRight,
  Cylinder,
  FlaskConical,
  Folder,
  Package,
  PinOff,
  ScanSearch,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import type {
  SidebarFoldId,
  SidebarRecord,
  SidebarSectionId,
  StageKey,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useInboxUnreadCount } from '../notifications/inbox-count';
import { useCommandMenu } from '../search/command-menu';
import { DonkeyMark } from './DonkeyMark';
import {
  activeNavKey,
  activeSubPage,
  LAB_NAME,
  SECTION_INFO,
  type NavItem,
  type SidebarNav,
  type SubPage,
} from './nav';
import { SidebarCustomize } from './SidebarCustomize';
import { SidebarFooter } from './SidebarFooter';
import type { SidebarPrefs } from './sidebar-prefs';
import { toggleIn } from './sidebar-prefs';

// Strata sidebar (DESIGN.md › Sidebar; STRATA-8, 9, 11, 38, 39, 40): static logo header and the
// "Search or scan" field; Today, Projects, Inbox; the person's sections in their order; Customize
// sidebar last; the account row in the footer. Rows are real links with aria-current inside
// <nav aria-label="Main">. Collapsed (Ctrl B) every row is a 44 px icon with a tooltip, and
// Retention, Inbox's pages, Pinned and Recent open a menu to the right.

/** Touch (phones in the Sheet, tablets): 44 px rows. Desktop and LAB stations keep 36 px. */
export const TOUCH_ROW = 'max-md:h-11 pointer-coarse:h-11';

/** Collapsed to icons on a desktop-width screen (the phone Sheet always shows labels). */
function useIconMode(): boolean {
  const { state, isMobile } = useSidebar();
  return state === 'collapsed' && !isMobile;
}

function NavRow({
  item,
  current,
  describedBy,
}: {
  item: NavItem;
  current: boolean;
  describedBy?: string;
}) {
  const Icon = item.icon;
  return (
    <SidebarMenuButton asChild isActive={current} tooltip={item.label} className={TOUCH_ROW}>
      <Link to={item.to} aria-current={current ? 'page' : undefined} aria-describedby={describedBy}>
        <Icon aria-hidden="true" />
        <span>{item.label}</span>
      </Link>
    </SidebarMenuButton>
  );
}

/** Collapsed sidebar: a 44 px icon with a tooltip that opens `children` in a menu to the right. */
function Flyout({
  icon: Icon,
  label,
  current = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton isActive={current} aria-label={`${label} pages`}>
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </SidebarMenuButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            {label}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-64">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/** A link inside a flyout menu, current page marked. */
function FlyoutLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem asChild>
      <Link to={to} aria-current={current ? 'page' : undefined}>
        {children}
      </Link>
    </DropdownMenuItem>
  );
}

function SubRows({ pages, current }: { pages: SubPage[]; current: string | null }) {
  return (
    <SidebarMenuSub>
      {pages.map((page) => (
        <SidebarMenuSubItem key={page.to}>
          <SidebarMenuSubButton asChild isActive={current === page.to} className={TOUCH_ROW}>
            <Link to={page.to} aria-current={current === page.to ? 'page' : undefined}>
              <span>{page.label}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
}

/**
 * Retention: unfolds Due and overdue and Disposal scan in place. Closed by default (a saved fold,
 * 'retention'); open by itself while you are on one of them, until its row is clicked there.
 * Collapsed: a flyout.
 */
function ParentRow({
  item,
  current,
  prefs,
}: {
  item: NavItem;
  current: boolean;
  prefs: SidebarPrefs;
}) {
  const { pathname } = useLocation();
  const iconMode = useIconMode();
  const [toggledHere, setToggledHere] = useState<string | null>(null);
  const sub = activeSubPage(pathname, item.children);
  const saved = !prefs.layout.folded.includes('retention');
  // Inside the section it opens by itself, unless its row was clicked on this page.
  const open = current && toggledHere !== pathname ? true : saved;
  const Icon = item.icon;
  if (iconMode) {
    return (
      <Flyout icon={item.icon} label={item.label} current={current}>
        {item.children.map((page) => (
          <FlyoutLink key={page.to} to={page.to} current={sub === page.to}>
            {page.label}
          </FlyoutLink>
        ))}
      </Flyout>
    );
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (current) setToggledHere(pathname);
        prefs.update((l) => ({
          ...l,
          folded: toggleIn<SidebarFoldId>(l.folded, 'retention', !next),
        }));
      }}
      asChild
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={current && !open} className={TOUCH_ROW}>
            <Icon aria-hidden="true" />
            <span>{item.label}</span>
            <ChevronRight
              aria-hidden="true"
              className="ml-auto transition-transform duration-200 ease-out group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none"
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SubRows pages={item.children} current={sub} />
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function ItemRow({
  item,
  active,
  prefs,
}: {
  item: NavItem;
  active: string | null;
  prefs: SidebarPrefs;
}) {
  const current = active === item.key;
  if (item.children.length > 0) return <ParentRow item={item} current={current} prefs={prefs} />;
  return (
    <SidebarMenuItem>
      <NavRow item={item} current={current} />
    </SidebarMenuItem>
  );
}

/**
 * Inbox (notifications for now) with its unread badge, and Action requests under it until the
 * unified Inbox (STRATA-25) holds both. The count is one value shared with the bell; hidden
 * when null or zero (LAB has no Inbox count).
 */
function InboxRow({ item, requests }: { item: NavItem; requests: SubPage | null }) {
  const { pathname } = useLocation();
  const iconMode = useIconMode();
  const count = useInboxUnreadCount();
  const countId = useId();
  const onRequests = requests ? activeSubPage(pathname, [requests]) !== null : false;
  const current = activeNavKey(pathname) === 'inbox';
  const shown = count !== null && count > 0;
  if (iconMode && requests) {
    return (
      <Flyout icon={item.icon} label={item.label} current={current}>
        <FlyoutLink to={item.to} current={current && !onRequests}>
          {item.label}
          {shown ? <span className="ml-auto font-mono text-[13px]">{count} unread</span> : null}
        </FlyoutLink>
        <FlyoutLink to={requests.to} current={onRequests}>
          {requests.label}
        </FlyoutLink>
      </Flyout>
    );
  }
  return (
    <SidebarMenuItem>
      <NavRow
        item={item}
        current={current && !onRequests}
        describedBy={shown ? countId : undefined}
      />
      {shown ? (
        <SidebarMenuBadge className="top-1/2 right-2 -translate-y-1/2 rounded-full bg-primary px-1.5 font-mono text-[11px] text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground">
          <span aria-hidden="true">{count > 9 ? '9+' : count}</span>
          {/* Read as the link's description; its name stays "Inbox". */}
          <span id={countId} className="sr-only">
            {count} unread
          </span>
        </SidebarMenuBadge>
      ) : null}
      {requests ? <SubRows pages={[requests]} current={onRequests ? requests.to : null} /> : null}
    </SidebarMenuItem>
  );
}

const STAGE_TINT: Record<StageKey, string> = {
  draft: 'bg-stage-draft-bg text-stage-draft-mark',
  storage: 'bg-stage-storage-bg text-stage-storage-mark',
  lab: 'bg-stage-lab-bg text-stage-lab-mark',
  due: 'bg-stage-due-bg text-stage-due-mark',
  danger: 'bg-stage-danger-bg text-stage-danger-mark',
  closed: 'bg-stage-closed-bg text-stage-closed-mark',
};

const KIND_ICON: Record<SidebarRecord['kind'], LucideIcon> = {
  project: Folder,
  storage_unit: Package,
  lab_program: FlaskConical,
  specimen_set: Cylinder,
};

/** Pinned and Recent rows: stage-tinted square, mono ID (never wraps), short name. */
function RecordLine({ record }: { record: SidebarRecord }) {
  const Icon = KIND_ICON[record.kind];
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded',
          record.available
            ? STAGE_TINT[record.stage ?? 'storage']
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="shrink-0 font-mono text-[13px] whitespace-nowrap">
        {record.label ?? 'Record'}
      </span>
      <span className="truncate text-muted-foreground">
        {record.available ? record.name : 'No access'}
      </span>
    </>
  );
}

const RECORD_EMPTY: Record<'pinned' | 'recent', string> = {
  pinned: 'Nothing pinned yet. Pin a record from its page.',
  recent: 'Records you open show here.',
};

/** A section heading that folds its section, like Notion's; the fold is saved for the person. */
function FoldingSection({
  id,
  prefs,
  children,
}: {
  id: SidebarSectionId;
  prefs: SidebarPrefs;
  children: ReactNode;
}) {
  const open = !prefs.layout.folded.includes(id);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) =>
        prefs.update((l) => ({ ...l, folded: toggleIn<SidebarFoldId>(l.folded, id, !next) }))
      }
      asChild
      className="group/section"
    >
      <SidebarGroup data-section={id}>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger
            className={cn(
              'w-full gap-1 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              TOUCH_ROW,
            )}
          >
            <span>{SECTION_INFO[id].label}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-3.5! opacity-0 transition-[transform,opacity] duration-150 ease-out group-focus-within/section:opacity-100 group-hover/section:opacity-100 group-data-[state=closed]/section:opacity-100 group-data-[state=open]/section:rotate-90 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>{children}</CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

const recordKey = (record: SidebarRecord) => `${record.kind}:${record.id}`;

function RecordSection({
  id,
  records,
  prefs,
}: {
  id: 'pinned' | 'recent';
  records: SidebarRecord[];
  prefs: SidebarPrefs;
}) {
  const { pathname } = useLocation();
  const iconMode = useIconMode();
  const info = SECTION_INFO[id];
  const open = (record: SidebarRecord) => record.available && record.href !== null;
  if (iconMode) {
    return (
      <SidebarGroup data-section={id}>
        <SidebarMenu>
          <Flyout icon={info.icon} label={info.label}>
            {records.length === 0 ? (
              <DropdownMenuItem disabled>{RECORD_EMPTY[id]}</DropdownMenuItem>
            ) : (
              records.map((record) =>
                open(record) ? (
                  <FlyoutLink
                    key={recordKey(record)}
                    to={record.href!}
                    current={pathname === record.href}
                  >
                    <RecordLine record={record} />
                  </FlyoutLink>
                ) : id === 'pinned' ? (
                  <DropdownMenuItem key={recordKey(record)} onSelect={() => prefs.unpin(record)}>
                    <RecordLine record={record} />
                    <span className="sr-only">Unpin</span>
                    <PinOff aria-hidden="true" className="ml-auto" />
                  </DropdownMenuItem>
                ) : null,
              )
            )}
          </Flyout>
        </SidebarMenu>
      </SidebarGroup>
    );
  }
  return (
    <FoldingSection id={id} prefs={prefs}>
      {records.length === 0 ? (
        <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{RECORD_EMPTY[id]}</p>
      ) : (
        <SidebarMenu>
          {records.map((record) => (
            <SidebarMenuItem key={recordKey(record)}>
              {open(record) ? (
                <SidebarMenuButton
                  asChild
                  isActive={pathname === record.href}
                  tooltip={record.label ?? undefined}
                  className={TOUCH_ROW}
                >
                  <Link
                    to={record.href!}
                    aria-current={pathname === record.href ? 'page' : undefined}
                  >
                    <RecordLine record={record} />
                  </Link>
                </SidebarMenuButton>
              ) : (
                // Lost access or deleted: says so, and can be unpinned.
                <div className="flex h-9 items-center gap-2 px-2 text-sm text-muted-foreground">
                  <RecordLine record={record} />
                </div>
              )}
              {!record.available && id === 'pinned' ? (
                <SidebarMenuAction
                  aria-label={`Unpin ${record.label ?? 'record'}`}
                  onClick={() => prefs.unpin(record)}
                >
                  <PinOff aria-hidden="true" />
                </SidebarMenuAction>
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </FoldingSection>
  );
}

function WorkSectionGroup({
  section,
  prefs,
  active,
}: {
  section: SidebarNav['sections'][number];
  prefs: SidebarPrefs;
  active: string | null;
}) {
  const iconMode = useIconMode();
  const rows = (
    <SidebarMenu>
      {section.items.map((item) => (
        <ItemRow key={item.key} item={item} active={active} prefs={prefs} />
      ))}
    </SidebarMenu>
  );
  // Collapsed to icons, folds are ignored: every page stays one click away.
  if (iconMode) return <SidebarGroup data-section={section.id}>{rows}</SidebarGroup>;
  return (
    <FoldingSection id={section.id} prefs={prefs}>
      {rows}
    </FoldingSection>
  );
}

/** Static logo tile, "Material Mule" and the lab: no switcher, not a link (DESIGN.md). */
function SidebarBrand() {
  return (
    <div className="flex h-12 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground [&_svg]:h-[19px] [&_svg]:w-6"
      >
        <DonkeyMark />
      </span>
      <span className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
        <span className="truncate font-semibold">Material Mule</span>
        <span className="truncate text-[13px] text-muted-foreground">{LAB_NAME}</span>
      </span>
    </div>
  );
}

/** The 36 px "Search or scan" field: opens the Ctrl K command menu (the search agent's). */
function SearchField() {
  const menu = useCommandMenu();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          variant="outline"
          tooltip="Search or scan a label (Ctrl K)"
          aria-label="Search or scan"
          aria-keyshortcuts="Control+K"
          aria-haspopup="dialog"
          onClick={() => menu.open()}
          className={cn(
            'rounded-full px-4 text-muted-foreground group-data-[collapsible=icon]:rounded-md group-data-[collapsible=icon]:px-2',
            TOUCH_ROW,
          )}
        >
          <ScanSearch aria-hidden="true" />
          <span className="group-data-[collapsible=icon]:hidden">Search or scan</span>
          <Kbd
            aria-hidden="true"
            className="ml-auto text-[13px] group-data-[collapsible=icon]:hidden"
          >
            Ctrl K
          </Kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Phone Sheet (MTR-136): closed by Escape or the overlay, focus goes back to Toggle Sidebar; closed
 * because a link inside it was followed, focus goes to the new page's h1 (or, while that page is
 * still loading, useFocusPageHeading puts it there once the h1 renders).
 */
function useSheetFocusToNewPage(pathname: string, openMobile: boolean) {
  const latestPath = useRef(pathname);
  const openedOn = useRef(pathname);
  useEffect(() => {
    latestPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (openMobile) openedOn.current = latestPath.current;
  }, [openMobile]);
  return (event: Event) => {
    // Radix returns focus to a Dialog.Trigger, and the top bar's toggle isn't one: do it here.
    event.preventDefault();
    if (latestPath.current === openedOn.current) {
      document.querySelector<HTMLElement>('header [data-sidebar="trigger"]')?.focus();
      return;
    }
    const heading = document.querySelector<HTMLElement>('#main h1');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  };
}

export function AppSidebar({
  nav,
  prefs,
  station,
}: {
  nav: SidebarNav;
  prefs: SidebarPrefs;
  /** Shared LAB station: no Pinned or Recent (a shared computer shows no one's). */
  station: boolean;
}) {
  const { pathname } = useLocation();
  const { state, setOpen, isMobile, openMobile } = useSidebar();
  const active = activeNavKey(pathname);
  const onMobileCloseAutoFocus = useSheetFocusToNewPage(pathname, openMobile);
  const [editing, setEditing] = useState(false);
  const customizeRef = useRef<HTMLButtonElement>(null);

  // The sections this person can have, in their order: never ones they can't use. Pinned and
  // Recent need the person's own records (never on a LAB station; hidden when refused).
  const available: SidebarSectionId[] = [
    ...(station || prefs.pins === null ? [] : (['pinned'] as const)),
    ...(station || prefs.recents === null ? [] : (['recent'] as const)),
    ...nav.sections.map((section) => section.id),
  ];
  const ordered = prefs.layout.order.filter((id) => available.includes(id));
  const shown = ordered.filter((id) => !prefs.layout.hidden.includes(id));

  const [top, inbox] = [
    nav.top.filter((item) => item.key !== 'inbox'),
    nav.top.find((item) => item.key === 'inbox'),
  ];

  const leaveEditing = () => {
    setEditing(false);
    // Focus goes back to the row once it is rendered again.
    requestAnimationFrame(() => customizeRef.current?.focus());
  };

  return (
    <Sidebar collapsible="icon" onMobileCloseAutoFocus={onMobileCloseAutoFocus}>
      <SidebarHeader className="gap-1">
        <SidebarBrand />
        <SearchField />
      </SidebarHeader>
      <SidebarContent>
        {editing ? (
          <SidebarCustomize
            sections={ordered}
            prefs={prefs}
            hasInbox={inbox !== undefined}
            onDone={leaveEditing}
          />
        ) : (
          <>
            <nav aria-label="Main" className="flex flex-col">
              <SidebarGroup>
                <SidebarMenu>
                  {top.map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <NavRow item={item} current={active === item.key} />
                    </SidebarMenuItem>
                  ))}
                  {inbox ? <InboxRow item={inbox} requests={nav.inboxRequests} /> : null}
                </SidebarMenu>
              </SidebarGroup>
              {shown.map((id) => {
                if (id === 'pinned') {
                  return (
                    <RecordSection key={id} id={id} records={prefs.pins ?? []} prefs={prefs} />
                  );
                }
                if (id === 'recent') {
                  return (
                    <RecordSection key={id} id={id} records={prefs.recents ?? []} prefs={prefs} />
                  );
                }
                const section = nav.sections.find((s) => s.id === id)!;
                return (
                  <WorkSectionGroup key={id} section={section} prefs={prefs} active={active} />
                );
              })}
            </nav>
            {/* Read-only on a LAB station (the picked person's layout): nothing to customize. */}
            <SidebarGroup className="mt-auto" hidden={prefs.readOnly}>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    ref={customizeRef}
                    tooltip="Customize sidebar"
                    onClick={() => {
                      // A collapsed sidebar opens first; the editor needs the labels.
                      if (state === 'collapsed' && !isMobile) setOpen(true);
                      setEditing(true);
                    }}
                    className={cn('text-muted-foreground', TOUCH_ROW)}
                  >
                    <SlidersHorizontal aria-hidden="true" />
                    <span>Customize sidebar</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
