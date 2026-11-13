import {
  ROLE_LABELS,
  SIDEBAR_SECTION_LABELS,
  type MeResponse,
  type SidebarSectionId,
} from '@materialmule/shared';
import {
  ArrowDownToLine,
  ClipboardCheck,
  Cylinder,
  FlaskConical,
  Folder,
  Hammer,
  HistoryIcon,
  Hourglass,
  House,
  Inbox,
  LayoutDashboard,
  OctagonPause,
  Package,
  Pin,
  SquareKanban,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { FEATURES, type FeatureFlag } from '../features';

// Navigation model, two views of the same pages:
// - the Strata sidebar (DESIGN.md › Sidebar): Today, Projects, Inbox; then the sections Pinned,
//   Recent, Storage units, Soils and Concrete (`sidebarNavFor`, `activeNavKey`);
// - the flat list of seven destinations (`destinationsFor`, `activeDestination`), still used for
//   page sections and the concrete lab tests.
//
// Navigation only, never authority: what the sidebar shows or hides grants and refuses nothing.
// Every permission is enforced by the server.

export type DestinationKey =
  'today' | 'projects' | 'receive' | 'inventory' | 'lab' | 'retention' | 'concrete';

/** A rail sub-page. `exact` pages are current only on their own path; others also below it. */
export interface SubPage {
  to: string;
  label: string;
  match: 'exact' | 'prefix';
}

export interface Destination {
  key: DestinationKey;
  to: string;
  label: string;
  /** Sub-pages shown in the rail group (drop-down); only when there are two or more. */
  children: SubPage[];
}

export type Features = Record<FeatureFlag, boolean>;

/** `pathname` is `base` or below it (`/projects` and `/projects/p1`, not `/projectsx`). */
function within(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Which destination (or the footer's Settings) a path belongs to; null for pages outside every
 * destination (notifications, action requests, search). Used instead of NavLink's own matching,
 * because several destinations own paths outside their link's prefix.
 */
export function activeDestination(pathname: string): DestinationKey | 'settings' | null {
  if (pathname === '/') return 'today';
  if (within(pathname, '/projects')) return 'projects';
  if (within(pathname, '/receiving-log') || within(pathname, '/labels/print/receipt')) {
    return 'receive';
  }
  if (
    within(pathname, '/sample-storage') ||
    within(pathname, '/inventory') ||
    within(pathname, '/storage-units')
  ) {
    return 'inventory';
  }
  // Concrete breaks and holds live under /lab-testing but belong to Concrete.
  if (within(pathname, '/lab-testing/concrete')) return 'concrete';
  if (within(pathname, '/lab-testing')) return 'lab';
  if (within(pathname, '/disposal-retention')) return 'retention';
  if (within(pathname, '/concrete')) return 'concrete';
  if (within(pathname, '/settings')) return 'settings';
  return null;
}

/** The sub-page of `pages` that is current at `pathname`, as its `to`; null when none is. */
export function activeSubPage(pathname: string, pages: readonly SubPage[]): string | null {
  const page = pages.find((p) =>
    p.match === 'exact' ? pathname === p.to : within(pathname, p.to),
  );
  return page?.to ?? null;
}

/**
 * Lab staff (MM-V2-C36): the Lab Technician role, Lab Managers and the shared LAB account. The
 * Concrete group's lab pages are navigation only: they show or hide nothing the server would
 * allow or refuse.
 */
export function isConcreteLabStaff(me: Pick<MeResponse, 'accountType' | 'roles'>): boolean {
  return (
    me.accountType === 'shared_lab' ||
    me.roles.includes('lab_technician') ||
    me.roles.includes('lab_manager')
  );
}

/** Concrete sub-pages in rail order, only those that exist for this session's features. */
function concretePages(labStaff: boolean, features: Features): SubPage[] {
  const pages: (SubPage | false)[] = [
    features.labTesting && { to: '/lab-testing/concrete', label: 'Breaks', match: 'exact' },
    features.concreteLab &&
      labStaff && { to: '/concrete/receiving', label: 'Receiving', match: 'prefix' },
    features.concreteLab &&
      labStaff && { to: '/concrete/specimens', label: 'Specimens', match: 'prefix' },
    features.labTesting && { to: '/lab-testing/concrete/holds', label: 'Holds', match: 'prefix' },
    features.concreteReview && { to: '/concrete/review', label: 'Review', match: 'prefix' },
  ];
  return pages.filter((page): page is SubPage => page !== false);
}

/** The rail's destinations for a session, in order, with their groups. */
export function destinationsFor(
  me: Pick<MeResponse, 'accountType' | 'roles'>,
  features: Features = FEATURES,
): Destination[] {
  const group = (pages: SubPage[]) => (pages.length > 1 ? pages : []);
  const list: (Destination | false)[] = [
    { key: 'today', to: '/', label: 'Today', children: [] },
    { key: 'projects', to: '/projects', label: 'Projects', children: [] },
    { key: 'receive', to: '/receiving-log', label: 'Receive', children: [] },
    { key: 'inventory', to: '/sample-storage', label: 'Inventory', children: [] },
    features.labTesting && { key: 'lab', to: '/lab-testing', label: 'Lab programs', children: [] },
    features.disposalRetention && {
      key: 'retention',
      to: '/disposal-retention',
      label: 'Retention',
      children: group([
        { to: '/disposal-retention', label: 'Due and overdue', match: 'exact' },
        { to: '/disposal-retention/scan', label: 'Disposal scan', match: 'prefix' },
      ]),
    },
    (features.concreteLab || features.concreteReview) && {
      key: 'concrete',
      // Without the Concrete dashboard, the section opens on the review queue.
      to: features.concreteLab ? '/concrete' : '/concrete/review',
      label: 'Concrete',
      children: group(concretePages(isConcreteLabStaff(me), features)),
    },
  ];
  return list.filter((item): item is Destination => item !== false);
}

/** Official initials when set, else the first letters of the first and last words of the name. */
export function accountInitials(me: Pick<MeResponse, 'initials' | 'displayName'>): string {
  if (me.initials) return me.initials;
  const words = me.displayName
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return '?';
  const first = words[0]!.match(/\p{L}/u)![0];
  const last = words.length > 1 ? words[words.length - 1]!.match(/\p{L}/u)![0] : '';
  return (first + last).toUpperCase();
}

const ACCOUNT_TYPE_LINES: Record<MeResponse['accountType'], string> = {
  personal: 'Personal account',
  shared_lab: 'Shared station',
  test: 'Test account',
};

/** The account row's role line: the person's roles, else what kind of account it is. */
export function accountRoleLine(me: Pick<MeResponse, 'roles' | 'accountType'>): string {
  if (me.roles.length > 0) return me.roles.map((role) => ROLE_LABELS[role]).join(', ');
  return ACCOUNT_TYPE_LINES[me.accountType];
}

/**
 * The lab shown under "Material Mule" and on a station's account row. One lab today (the
 * receiving lab of the reference data); a per-site name waits on a lab setting.
 */
export const LAB_NAME = 'Receiving lab';

/** The account row's two lines. A shared LAB station reads as the station, not a person. */
export function accountRowText(me: Pick<MeResponse, 'accountType' | 'displayName' | 'roles'>): {
  name: string;
  line: string;
} {
  if (me.accountType === 'shared_lab') return { name: 'LAB station', line: `Shared · ${LAB_NAME}` };
  return { name: me.displayName, line: accountRoleLine(me) };
}

// ---- Strata sidebar ----

/** Every sidebar row that can be the current page. */
export type NavKey =
  | 'today'
  | 'projects'
  | 'inbox'
  | 'receive'
  | 'inventory'
  | 'retention'
  | 'lab-programs'
  | 'workboard'
  | 'concrete-overview'
  | 'breaks'
  | 'concrete-receiving'
  | 'specimens'
  | 'holds'
  | 'review';

export interface NavItem {
  key: NavKey;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Sub-pages that unfold in place (Retention); empty for plain rows. */
  children: SubPage[];
}

export type WorkSectionId = Exclude<SidebarSectionId, 'pinned' | 'recent'>;

export interface WorkSection {
  id: WorkSectionId;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export interface SidebarNav {
  /** Today, Projects, Inbox: always first, never folded, moved or hidden. */
  top: NavItem[];
  /** The work sections this session can use, in default order; empty ones are left out. */
  sections: WorkSection[];
}

/** Heading and icon (collapsed flyouts, Customize sidebar) of every movable section. */
export const SECTION_INFO: Record<SidebarSectionId, { label: string; icon: LucideIcon }> = {
  pinned: { label: SIDEBAR_SECTION_LABELS.pinned, icon: Pin },
  recent: { label: SIDEBAR_SECTION_LABELS.recent, icon: HistoryIcon },
  storage_units: { label: SIDEBAR_SECTION_LABELS.storage_units, icon: Package },
  soils: { label: SIDEBAR_SECTION_LABELS.soils, icon: FlaskConical },
  concrete: { label: SIDEBAR_SECTION_LABELS.concrete, icon: Cylinder },
};

/** The fixed rows Customize sidebar lists as locked. */
export const FIXED_PAGES: readonly { label: string; icon: LucideIcon }[] = [
  { label: 'Today', icon: House },
  { label: 'Projects', icon: Folder },
  { label: 'Inbox', icon: Inbox },
];

const row = (key: NavKey, to: string, label: string, icon: LucideIcon): NavItem => ({
  key,
  to,
  label,
  icon,
  children: [],
});

const present = (items: (NavItem | false)[]): NavItem[] =>
  items.filter((item): item is NavItem => item !== false);

/**
 * The sidebar for a session. Keeps today's feature flags and lab-staff gates: Receiving and
 * Specimens only for lab staff; Overview with the Concrete dashboard (concreteLab).
 */
export function sidebarNavFor(
  me: Pick<MeResponse, 'accountType' | 'roles' | 'permissions'>,
  features: Features = FEATURES,
): SidebarNav {
  const can = (permission: string) => me.permissions.includes(permission);
  const top = [row('today', '/', 'Today', House), row('projects', '/projects', 'Projects', Folder)];
  // The single Inbox (STRATA-24): requests and updates in one place.
  // A LAB station shows the picked person's Inbox only with their consent (STRATA-27); the page
  // and the badge read the station route, never the shared account's own feed.
  if (can('notification.read') || can('action_item.read') || me.accountType === 'shared_lab') {
    top.push(row('inbox', '/inbox', 'Inbox', Inbox));
  }

  const labStaff = isConcreteLabStaff(me);
  const storage = present([
    row('receive', '/receiving-log', 'Receive', ArrowDownToLine),
    row('inventory', '/sample-storage', 'Inventory', Package),
    features.disposalRetention && {
      ...row('retention', '/disposal-retention', 'Retention', Hourglass),
      children: [
        { to: '/disposal-retention', label: 'Due and overdue', match: 'exact' },
        { to: '/disposal-retention/scan', label: 'Disposal scan', match: 'prefix' },
      ],
    },
  ]);
  const soils = present([
    features.labTesting &&
      row('lab-programs', '/lab-testing/programs', 'Lab programs', FlaskConical),
    // STRATA-10: the Lab Testing Worklist, renamed.
    features.labTesting && row('workboard', '/lab-testing', 'Workboard', SquareKanban),
  ]);
  const concrete = present([
    features.concreteLab && row('concrete-overview', '/concrete', 'Overview', LayoutDashboard),
    features.labTesting && row('breaks', '/lab-testing/concrete', 'Breaks', Hammer),
    features.concreteLab &&
      labStaff &&
      row('concrete-receiving', '/concrete/receiving', 'Receiving', Truck),
    features.concreteLab &&
      labStaff &&
      row('specimens', '/concrete/specimens', 'Specimens', Cylinder),
    features.labTesting && row('holds', '/lab-testing/concrete/holds', 'Holds', OctagonPause),
    features.concreteReview && row('review', '/concrete/review', 'Review', ClipboardCheck),
  ]);
  const sections: WorkSection[] = [
    { id: 'storage_units' as const, ...SECTION_INFO.storage_units, items: storage },
    { id: 'soils' as const, ...SECTION_INFO.soils, items: soils },
    { id: 'concrete' as const, ...SECTION_INFO.concrete, items: concrete },
  ].filter((section) => section.items.length > 0);
  return { top, sections };
}

/**
 * The sidebar row a path belongs to; 'settings' and 'help' for the account menu's pages; null
 * for pages outside every row (search, unit labels). Several rows own paths outside their link's
 * prefix, so this replaces NavLink's own matching.
 */
export function activeNavKey(pathname: string): NavKey | 'settings' | 'help' | null {
  if (pathname === '/') return 'today';
  if (within(pathname, '/projects')) return 'projects';
  if (
    within(pathname, '/inbox') ||
    within(pathname, '/notifications') ||
    within(pathname, '/action-requests')
  ) {
    return 'inbox';
  }
  if (within(pathname, '/receiving-log') || within(pathname, '/labels/print/receipt')) {
    return 'receive';
  }
  if (
    within(pathname, '/sample-storage') ||
    within(pathname, '/inventory') ||
    within(pathname, '/storage-units')
  ) {
    return 'inventory';
  }
  if (within(pathname, '/disposal-retention')) return 'retention';
  // Concrete breaks and holds live under /lab-testing but belong to Concrete.
  if (within(pathname, '/lab-testing/concrete/holds')) return 'holds';
  if (within(pathname, '/lab-testing/concrete')) return 'breaks';
  if (within(pathname, '/lab-testing/programs')) return 'lab-programs';
  if (within(pathname, '/lab-testing')) return 'workboard';
  if (within(pathname, '/concrete/receiving')) return 'concrete-receiving';
  if (within(pathname, '/concrete/specimens')) return 'specimens';
  if (within(pathname, '/concrete/review') || within(pathname, '/concrete/strength')) {
    return 'review';
  }
  // The testing table is opened from Breaks.
  if (within(pathname, '/concrete/testing')) return 'breaks';
  if (within(pathname, '/concrete')) return 'concrete-overview';
  if (within(pathname, '/settings')) return 'settings';
  if (within(pathname, '/help')) return 'help';
  return null;
}

/** The section holding the current row, so a folded one can show it is there. */
export function sectionOfKey(nav: SidebarNav, key: string | null): WorkSectionId | null {
  return nav.sections.find((section) => section.items.some((i) => i.key === key))?.id ?? null;
}
