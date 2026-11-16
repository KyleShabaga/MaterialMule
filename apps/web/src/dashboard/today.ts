import {
  activityTime,
  formatRecordDate,
  LAB_TIME_ZONE,
  NEEDS_YOU_FIRST,
  type ActivityScope,
  type DateFormatPreference,
  type MeResponse,
  type NeedsYouSystemKind,
  type ScopedActivityItem,
  type StageKey,
} from '@materialmule/shared';
import type { FeatureFlag } from '../features';
import { NEW_PROJECT_PATH, RECEIVE_PATH } from '../search/menu-items';

// Today with an own account (Strata; DESIGN.md "Today with an own account", "Today for the Lab
// Manager", "Today for a technician"): what the welcome says, which shortcut set and activity
// scope an account gets, and how the two lists are cut. Pure, so the wording is unit tested.

// ---------------------------------------------------------------------------------------------
// Welcome

const HOUR = new Intl.DateTimeFormat('en-CA', {
  timeZone: LAB_TIME_ZONE,
  hour: 'numeric',
  hourCycle: 'h23',
});
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: LAB_TIME_ZONE, weekday: 'long' });

export function partOfDay(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(HOUR.format(now));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** The first word of the person's name, without a bracketed note ("Dana Tester (Lab)" → Dana). */
export function firstName(displayName: string): string | null {
  const word = displayName
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .find((w) => /\p{L}/u.test(w));
  return word ?? null;
}

/** "Good morning, Alex" (morning before noon, afternoon before 5 PM, in America/Edmonton). */
export function greetingText(name: string | null, now: Date): string {
  return `Good ${partOfDay(now)}${name ? `, ${name}` : ''}`;
}

/** "Friday, 2026-11-13" or "Friday, Nov 13, 2026": the weekday, then the person's Date format. */
export function welcomeDate(now: Date, preference: DateFormatPreference): string {
  return `${WEEKDAY.format(now)}, ${formatRecordDate(now, preference)}`;
}

// ---------------------------------------------------------------------------------------------
// Which Today an account gets (shortcuts, activity scope, clear-day hint)

export type TodayRole = 'manager' | 'lead' | 'technician';

/**
 * One rule, from the account's roles and project leads, never its job title: the Lab Manager
 * set when the account has the Lab Manager role; else the lead set when the person is the Lead
 * Project Engineer of any project; else the technician set. Sets are never merged.
 */
export function todayRole(me: Pick<MeResponse, 'roles'>, leadsAnyProject: boolean): TodayRole {
  if (me.roles.includes('lab_manager')) return 'manager';
  if (leadsAnyProject) return 'lead';
  return 'technician';
}

/** Last 24 hours: the whole lab, my projects, or my own work. */
export const ACTIVITY_SCOPE_BY_ROLE: Record<TodayRole, ActivityScope> = {
  manager: 'lab',
  lead: 'projects',
  technician: 'mine',
};

/** What a clear day says will appear in Needs you. */
export const CLEAR_HINT_BY_ROLE: Record<TodayRole, string> = {
  lead: 'Requests in your Inbox, reports to review and HOLDs show up here.',
  manager: 'Holds, unassigned requests, breaks and disposals show up here.',
  technician: 'Tests assigned to you, units to pull and drafts to finish show up here.',
};

export type ShortcutIcon =
  | 'flask-conical'
  | 'clipboard-check'
  | 'folder'
  | 'folder-plus'
  | 'square-kanban'
  | 'hammer'
  | 'hourglass'
  | 'scan-line'
  | 'arrow-down-to-line'
  | 'arrow-right-left'
  | 'printer';

export interface Shortcut {
  label: string;
  to: string;
  icon: ShortcutIcon;
}

interface ShortcutRule extends Shortcut {
  /** Shown only when the account holds every one of these global permissions. */
  permissions: readonly string[];
  /** And only when this feature is on. */
  feature?: FeatureFlag;
}

const SHORTCUTS: Record<TodayRole, readonly ShortcutRule[]> = {
  lead: [
    {
      label: 'Request lab testing',
      to: '/lab-testing/programs/new',
      icon: 'flask-conical',
      permissions: ['lab_program.manage'],
      feature: 'labTesting',
    },
    // Review is project-scoped: the queue lists only what this person may review.
    {
      label: 'Review concrete reports',
      to: '/concrete/review',
      icon: 'clipboard-check',
      permissions: [],
      feature: 'concreteReview',
    },
    { label: 'My projects', to: '/projects?tab=mine', icon: 'folder', permissions: [] },
    {
      label: 'New project',
      to: NEW_PROJECT_PATH,
      icon: 'folder-plus',
      permissions: ['receipt.draft', 'project.create'],
    },
  ],
  manager: [
    {
      label: 'Workboard',
      to: '/lab-testing',
      icon: 'square-kanban',
      permissions: ['lab_program.read'],
      feature: 'labTesting',
    },
    // The Breaks page opens on today's breaks.
    {
      label: 'Breaks due today',
      to: '/lab-testing/concrete',
      icon: 'hammer',
      permissions: [],
      feature: 'labTesting',
    },
    {
      label: 'Retention due',
      to: '/disposal-retention',
      icon: 'hourglass',
      permissions: ['inventory.read'],
      feature: 'disposalRetention',
    },
    {
      label: 'Disposal scan',
      to: '/disposal-retention/scan',
      icon: 'scan-line',
      permissions: ['storage_unit.dispose_scan'],
      feature: 'disposalRetention',
    },
  ],
  technician: [
    {
      label: 'Receive',
      to: RECEIVE_PATH,
      icon: 'arrow-down-to-line',
      permissions: ['receipt.draft'],
    },
    {
      label: 'Move storage units',
      to: '/sample-storage/move',
      icon: 'arrow-right-left',
      permissions: ['storage_unit.move'],
    },
    // Labels are chosen on Inventory (check units, then Print labels).
    {
      label: 'Print labels',
      to: '/sample-storage',
      icon: 'printer',
      permissions: ['label.print', 'inventory.read'],
    },
    {
      label: 'My tests',
      to: '/lab-testing',
      icon: 'square-kanban',
      permissions: ['lab_program.read'],
      feature: 'labTesting',
    },
  ],
};

/** The role's shortcuts this account can use (its permissions and the features that are on). */
export function shortcutsFor(
  role: TodayRole,
  me: Pick<MeResponse, 'permissions'>,
  features: Record<FeatureFlag, boolean>,
): Shortcut[] {
  return SHORTCUTS[role]
    .filter(
      (rule) =>
        (!rule.feature || features[rule.feature]) &&
        rule.permissions.every((p) => me.permissions.includes(p)),
    )
    .map(({ label, to, icon }) => ({ label, to, icon }));
}

// ---------------------------------------------------------------------------------------------
// Needs you

/** The rows shown: the first six until "Show all n" is chosen. */
export function visibleNeeds<T>(items: readonly T[], expanded: boolean): T[] {
  return expanded ? [...items] : items.slice(0, NEEDS_YOU_FIRST);
}

/** How a system source that couldn't load is named in the muted note. */
export const SYSTEM_KIND_NAMES: Record<NeedsYouSystemKind, string> = {
  concrete_holds: 'sets on HOLD',
  concrete_reviews: 'reports to review',
  breaks_due: 'breaks due today',
  tests_assigned: 'tests assigned to you',
  lab_unassigned: 'unassigned lab requests',
  retention_due: 'retention due',
  disposal_approved: 'units approved for disposal',
  labels_failed: 'labels that didn’t print',
  drafts_old: 'draft receipts',
  location_conflicts: 'location checks',
  program_finished: 'finished lab programs',
};

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Couldn't load breaks due today and retention due. The rest is up to date." */
export function unavailableNote(kinds: readonly NeedsYouSystemKind[]): string | null {
  if (kinds.length === 0) return null;
  const names = joinWords([...new Set(kinds)].map((kind) => SYSTEM_KIND_NAMES[kind]));
  return `Couldn’t load ${names}. Everything else here is up to date.`;
}

// ---------------------------------------------------------------------------------------------
// Text with IDs set in mono

export interface TextPart {
  text: string;
  mono: boolean;
}

/** Storage unit IDs and project numbers, found in sentences the server wrote. */
const ID_PATTERN =
  /\b(?:(?:BKT|ST|CRE|CT)-\d{4}-\d{6}|[A-Z]{2,6}-\d{4}(?:-\d{4})?|TH\d{2}-\d{2})\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits `text` so each ID (the given `ids`, else anything shaped like one) can be set in mono. */
export function monoParts(text: string, ids: readonly string[] = []): TextPart[] {
  const known = [...new Set(ids.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = known.length
    ? new RegExp(`${known.map(escapeRegExp).join('|')}|${ID_PATTERN.source}`, 'g')
    : new RegExp(ID_PATTERN.source, 'g');
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) parts.push({ text: text.slice(last, at), mono: false });
    parts.push({ text: match[0], mono: true });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mono: false });
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Last 24 hours

/**
 * The person's own rows in the second person: the server writes "AT received …" (initials, else
 * name); when the signed-in person did it, "You received …".
 */
export function activitySentence(item: ScopedActivityItem): string {
  if (!item.byMe) return item.summary;
  for (const who of [item.actorInitials, item.actorName]) {
    if (who && item.summary.startsWith(who)) {
      const rest = item.summary.slice(who.length);
      if (rest.startsWith(' ')) return `You${rest}`;
      if (rest.startsWith(':')) return `You${rest}`;
    }
  }
  return item.summary;
}

/** The stage dot for an activity line (decoration; the sentence says what happened). */
export function activityStage(action: string): StageKey {
  if (action.startsWith('disposal.')) return 'closed';
  if (action.startsWith('retention.')) return 'due';
  if (
    action.startsWith('test.') ||
    action.startsWith('lab_program.') ||
    action.startsWith('program.') ||
    action.startsWith('concrete')
  ) {
    return 'lab';
  }
  return 'storage';
}

export interface ActivityLine {
  item: ScopedActivityItem;
  sentence: string;
  time: string;
  stage: StageKey;
}

/**
 * Today's lines, then yesterday's (newest first in each), each with its clock time. Lines older
 * than 24 hours are left out; a line from a clock slightly ahead counts as today.
 */
export function splitActivity(
  items: readonly ScopedActivityItem[],
  now: Date,
): { today: ActivityLine[]; yesterday: ActivityLine[] } {
  const today: ActivityLine[] = [];
  const yesterday: ActivityLine[] = [];
  for (const item of items) {
    const at = activityTime(item.occurredAt, now);
    const future = new Date(item.occurredAt).getTime() > now.getTime();
    if (!at.withinDay && !future) continue;
    const line: ActivityLine = {
      item,
      sentence: activitySentence(item),
      time: at.time,
      stage: activityStage(item.action),
    };
    (at.yesterday && !future ? yesterday : today).push(line);
  }
  return { today, yesterday };
}
