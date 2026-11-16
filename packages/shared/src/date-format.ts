// STRATA-70: one rule for dates and times (DESIGN.md, Today › Dates and times), shared by every
// surface. Pure functions: callers pass the instant, the current time and the person's preference.
// The lab's time zone is America/Edmonton. Stored values are never changed; these only format.
//
// - Record dates (received, retain until, placed): the person's Date format, 2026-11-11 by default.
// - Activity in the last 24 hours: a clock time with AM or PM, and "Yesterday" for lines before
//   today's midnight.
// - Inbox: short relative times (Just now, 12 min, 3 h), then weekdays, then the record date.

export const LAB_TIME_ZONE = 'America/Edmonton';

/** The person's Date format setting: ISO (2026-11-11, the default) or medium (Nov 11, 2026). */
export type DateFormatPreference = 'iso' | 'medium';
export const DEFAULT_DATE_FORMAT: DateFormatPreference = 'iso';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const labDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: LAB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: LAB_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const weekday = new Intl.DateTimeFormat('en-US', { timeZone: LAB_TIME_ZONE, weekday: 'short' });
// Formats a calendar date that is already in the lab's calendar, so it uses UTC to avoid a shift.
const mediumDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function toInstant(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The lab's calendar date (YYYY-MM-DD) of an instant, or of a date-only string unchanged. */
export function labCalendarDate(value: string | Date): string | null {
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
  const instant = toInstant(value);
  return instant ? labDay.format(instant) : null;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A record date in the person's format. Date-only strings (YYYY-MM-DD) are calendar dates and are
 * never moved through UTC; timestamps show the lab's calendar date. Invalid input returns ''.
 */
export function formatRecordDate(
  value: string | Date | null | undefined,
  preference: DateFormatPreference = DEFAULT_DATE_FORMAT,
): string {
  if (value == null || value === '') return '';
  const date = labCalendarDate(value);
  if (!date) return '';
  if (preference === 'iso') return date;
  return mediumDate.format(new Date(`${date}T12:00:00Z`));
}

/** "2:05 PM": the clock time of an instant in the lab's time zone. */
export function formatClockTime(value: string | Date): string {
  const instant = toInstant(value);
  return instant ? clock.format(instant) : '';
}

export interface ActivityTime {
  /** The clock time, "2:05 PM". */
  time: string;
  /** True when the instant falls before today's midnight in the lab (the "Yesterday" label). */
  yesterday: boolean;
  /** False when the instant is older than 24 hours or in the future: the line is not shown. */
  withinDay: boolean;
}

/** How a line in "Last 24 hours" shows its time. */
export function activityTime(value: string | Date, now: Date): ActivityTime {
  const instant = toInstant(value);
  if (!instant) return { time: '', yesterday: false, withinDay: false };
  const age = now.getTime() - instant.getTime();
  const withinDay = age >= 0 && age <= 24 * 60 * 60 * 1000;
  const today = labDay.format(now);
  return {
    time: clock.format(instant),
    yesterday: labDay.format(instant) === shiftDate(today, -1),
    withinDay,
  };
}

/**
 * Inbox age: "Just now" under a minute, "12 min" under an hour, "3 h" under 24 hours, then the
 * weekday ("Mon") within the last 6 days, then the record date. A future instant (a clock ahead of
 * the server) reads "Just now".
 */
export function inboxAge(
  value: string | Date,
  now: Date,
  preference: DateFormatPreference = DEFAULT_DATE_FORMAT,
): string {
  const instant = toInstant(value);
  if (!instant) return '';
  const minutes = Math.floor((now.getTime() - instant.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  const today = labDay.format(now);
  const day = labDay.format(instant);
  if (day >= shiftDate(today, -6)) return weekday.format(instant);
  return formatRecordDate(instant, preference);
}
