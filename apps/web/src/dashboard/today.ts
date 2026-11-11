import type { BadgeTone } from '../components/ui';

// Today (Field Ledger, canvas Main and PhoneToday): what the greeting block says and how the
// "Needs you" queue is ordered. Pure, so the wording and the order are unit tested.

const ZONE = 'America/Edmonton';

/** One row of "Needs you": a count of real things and the screen that clears them. */
export interface NeedsItem {
  key: NeedsKey;
  tag: { label: string; tone: BadgeTone };
  title: string;
  sub: string;
  action: string;
  href: string;
  /** The greeting's flag action when this one is first ("Start with the labels"). */
  lead: string;
  /** Why this one is first, when it is (mono caps note in the greeting block). */
  why: string;
}

/** In urgency order: the first present one is the greeting's flag action. */
export const NEEDS_ORDER = [
  'print-queue',
  'action-requests',
  'labels',
  'conflicts',
  'drafts',
  'retention',
  'lab',
] as const;
export type NeedsKey = (typeof NEEDS_ORDER)[number];

export function byUrgency(items: readonly NeedsItem[]): NeedsItem[] {
  return [...items].sort((a, b) => NEEDS_ORDER.indexOf(a.key) - NEEDS_ORDER.indexOf(b.key));
}

const HOUR = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  hour: 'numeric',
  hourCycle: 'h23',
});
const DATE_LINE = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const SHORT_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

/** "TUE 10 NOV 2026" in the lab's time zone. */
export function todayLine(now: Date): string {
  return DATE_LINE.format(now).replace(/,/g, '').toUpperCase();
}

/** "TUE 10 NOV" for the phone header strip. */
export function shortTodayLine(now: Date): string {
  return SHORT_DATE.format(now).replace(/,/g, '').toUpperCase();
}

function partOfDay(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(HOUR.format(now));
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** The first word of the person's name, without a bracketed note ("Dana Tester (Lab)" → Dana). */
export function firstName(displayName: string): string | null {
  const word = displayName
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .find((w) => /\p{L}/u.test(w));
  return word ?? null;
}

/**
 * "Good morning, Dana. Five things need you today." The shared LAB station is not a person, so
 * it is greeted without a name.
 */
export function greeting(name: string | null, count: number, now: Date): string {
  const hello = `Good ${partOfDay(now)}${name ? `, ${name}` : ''}.`;
  if (count === 0) return `${hello} Nothing needs you today.`;
  const words = count < WORDS.length ? WORDS[count]! : String(count);
  return `${hello} ${words} ${count === 1 ? 'thing needs' : 'things need'} you today.`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "DEMO-2611 and DEMO-2613", "DEMO-2611, DEMO-2612 and 3 more". */
export function listNames(names: readonly string[], shown = 2): string {
  const unique = [...new Set(names)];
  if (unique.length <= shown) {
    return unique.length === 2 ? `${unique[0]} and ${unique[1]}` : unique.join(', ');
  }
  return `${unique.slice(0, shown).join(', ')} and ${unique.length - shown} more`;
}

/** Days, rounded down, for "oldest open test" notes. */
export function wholeDays(seconds: number): number {
  return Math.floor(seconds / 86_400);
}
