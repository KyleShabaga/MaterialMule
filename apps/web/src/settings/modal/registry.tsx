import type { MeResponse as Me } from '@materialmule/shared';
import {
  Activity,
  ArrowDownToLine,
  Bell,
  CalendarOff,
  Factory,
  FileText,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutTemplate,
  MapPin,
  Printer,
  SlidersHorizontal,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Every Settings section (DESIGN.md › Round 9 and STRATA-100): its URL slug, label, group, icon,
 * who sees it, and whether it opens as a full page (STRATA-128: Staff, Locations, Lab tests).
 *
 * The nav shows only the sections a person can open ("hidden, not locked"). This is never the
 * enforcement: every read and change is checked by the server, and a direct URL to a hidden
 * section opens My access with a notice instead.
 *
 * Slugs keep today's `/settings/*` addresses (`access`, `report-header`, `system-status`) so
 * links and bookmarks keep working; the three page sections redirect to `/admin/*`.
 */
export type SettingsGroupKey = 'account' | 'lab' | 'concrete' | 'system';

export interface SettingsSection {
  slug: string;
  label: string;
  group: SettingsGroupKey;
  icon: LucideIcon;
  /** Extra words for "Search settings". */
  keywords?: string;
  /** A full page under Lab admin, not a modal panel (STRATA-128). */
  page?: string;
  /** Who sees it in the nav. The server decides every read and change regardless. */
  visible: (me: Me) => boolean;
  /**
   * Reference data everyone may read (MISC-04 Locations, MM-V2-C27 Equipment, C37 Suppliers and
   * Holidays, C32 Report header): it opens by address, read-only, for people who don't see it in
   * the nav. Sections without this have no page for people who can't see them.
   */
  readableByAll?: true;
}

export const SETTINGS_GROUP_LABELS: Record<SettingsGroupKey, string> = {
  account: 'Account',
  lab: 'Lab',
  concrete: 'Concrete',
  system: 'System',
};

const can = (me: Me, ...permissions: string[]) =>
  permissions.some((permission) => me.permissions.includes(permission));

const always = () => true;

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    slug: 'profile',
    label: 'Profile',
    group: 'account',
    icon: UserRound,
    keywords: 'name email initials position photo microsoft',
    visible: always,
  },
  {
    slug: 'preferences',
    label: 'Preferences',
    group: 'account',
    icon: SlidersHorizontal,
    keywords: 'theme dark light table rows compact date format scanning sidebar privacy inbox',
    visible: always,
  },
  {
    slug: 'notifications',
    label: 'Notifications',
    group: 'account',
    icon: Bell,
    keywords: 'bell badge count updates requests',
    visible: always,
  },
  {
    slug: 'access',
    label: 'My access',
    group: 'account',
    icon: KeyRound,
    keywords: 'roles permissions what you can do',
    visible: always,
  },
  {
    slug: 'staff',
    label: 'Staff',
    group: 'lab',
    icon: Users,
    keywords: 'people roles pending approve disable admin',
    page: '/admin/staff',
    visible: (me) => can(me, 'staff.manage'),
  },
  {
    slug: 'locations',
    label: 'Locations',
    group: 'lab',
    icon: MapPin,
    keywords: 'warehouse bay shelf storage term retire',
    page: '/admin/locations',
    readableByAll: true,
    visible: (me) => can(me, 'location.manage'),
  },
  {
    slug: 'printers',
    label: 'Printers',
    group: 'lab',
    icon: Printer,
    keywords: 'zebra test print label printer',
    visible: (me) => can(me, 'printer.manage'),
  },
  {
    slug: 'templates',
    label: 'Templates',
    group: 'lab',
    icon: LayoutTemplate,
    keywords: 'lab program templates',
    visible: (me) => can(me, 'test_catalog.manage'),
  },
  {
    slug: 'receiving',
    label: 'Receiving',
    group: 'lab',
    icon: ArrowDownToLine,
    keywords: 'drafts auto delete',
    visible: (me) => can(me, 'settings.drafts.manage'),
  },
  {
    slug: 'tests',
    label: 'Lab tests',
    group: 'lab',
    icon: FlaskConical,
    keywords: 'test catalogue soils',
    page: '/admin/lab-tests',
    visible: (me) => can(me, 'test_catalog.manage'),
  },
  {
    slug: 'equipment',
    label: 'Equipment',
    group: 'concrete',
    icon: Gauge,
    keywords: 'testing machine air meter calibration',
    readableByAll: true,
    visible: (me) =>
      can(me, 'concrete_settings.testing_machine.manage', 'concrete_settings.air_meter.manage'),
  },
  {
    slug: 'suppliers',
    label: 'Suppliers',
    group: 'concrete',
    icon: Factory,
    keywords: 'concrete supplier ready mix',
    readableByAll: true,
    visible: (me) => can(me, 'concrete_settings.supplier.manage'),
  },
  {
    slug: 'holidays',
    label: 'Holidays',
    group: 'concrete',
    icon: CalendarOff,
    keywords: 'non test days calendar',
    readableByAll: true,
    visible: (me) => can(me, 'concrete_settings.holiday.manage'),
  },
  {
    slug: 'report-header',
    label: 'Report header',
    group: 'concrete',
    icon: FileText,
    keywords: 'company name address phone',
    readableByAll: true,
    visible: (me) => can(me, 'concrete_settings.report_header.manage'),
  },
  {
    slug: 'system-status',
    label: 'System status',
    group: 'system',
    icon: Activity,
    keywords: 'database backups alerts lab station computer',
    visible: (me) => can(me, 'system.status.read'),
  },
];

/** Old addresses that now have another slug. */
const ALIASES: Record<string, string> = { 'lab-tests': 'tests', system: 'system-status' };

export function findSection(slug: string | undefined): SettingsSection | undefined {
  if (!slug) return undefined;
  const key = ALIASES[slug] ?? slug;
  return SETTINGS_SECTIONS.find((section) => section.slug === key);
}

/** Whether this person may open a section by its address (the nav shows fewer). */
export function canOpenSection(me: Me, section: SettingsSection): boolean {
  return section.visible(me) || section.readableByAll === true;
}

/** The sections this person sees, in nav order. */
export function visibleSections(me: Me): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.visible(me));
}

/** "Search settings": label, group and keywords, every word must match. */
export function matchesSearch(section: SettingsSection, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack =
    `${section.label} ${SETTINGS_GROUP_LABELS[section.group]} ${section.keywords ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** `/settings` and every `/settings/<section>`: the addresses that open the Settings modal. */
export function isSettingsPath(pathname: string): boolean {
  return /^\/settings(\/|$)/.test(pathname);
}

const LAST_SECTION_KEY = 'materialmule:settings-last-section';

/** Settings opens on the last section visited (per browser; falls back to Profile). */
export function readLastSection(): string {
  try {
    return window.localStorage.getItem(LAST_SECTION_KEY) ?? 'profile';
  } catch {
    return 'profile';
  }
}

export function writeLastSection(slug: string): void {
  try {
    window.localStorage.setItem(LAST_SECTION_KEY, slug);
  } catch {
    // Storage blocked: Settings opens on Profile next time.
  }
}
