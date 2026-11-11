import { ROLE_LABELS, type MeResponse } from '@materialmule/shared';
import { FEATURES, type FeatureFlag } from '../features';

// Field Ledger shell (docs/redesign/design.md, "Shell additions"): seven destinations as plain
// text links, Projects second and Concrete last; Settings sits in the rail footer.
//
// Navigation only, never authority: what the rail shows or hides grants and refuses nothing.
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

type Features = Record<FeatureFlag, boolean>;

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

/**
 * Whether the phone bar's Find slot can open Lab search (MM-V2-C31: behind the concreteLab flag
 * and `inventory.read`); otherwise Find opens Inventory.
 */
export function canUseLabSearch(
  me: Pick<MeResponse, 'permissions'>,
  features: Features = FEATURES,
): boolean {
  return features.concreteLab && me.permissions.includes('inventory.read');
}

export function accountBadge(me: MeResponse): { label: string; tone: 'info' | 'warning' } {
  switch (me.accountType) {
    case 'shared_lab':
      return { label: 'Shared station: LAB', tone: 'info' };
    case 'test':
      return { label: 'TEST', tone: 'warning' };
    default:
      return { label: 'Personal', tone: 'info' };
  }
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
