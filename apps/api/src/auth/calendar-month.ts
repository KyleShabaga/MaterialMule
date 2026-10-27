// Calendar-month arithmetic in a named time zone (MM-T06). LAB sessions last exactly one calendar
// month from sign-in "on the wall clock" of the business time zone, so a sign-in late on the last
// evening of a month or across a DST change still ends at the same local time a month later.

interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local date and time of `instant` in `timeZone`. */
export function wallClockAt(instant: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
    millisecond: ((instant % 1000) + 1000) % 1000,
  };
}

function wallAsUtc(wall: WallClock): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
}

/** UTC offset of `timeZone` at `instant`, in milliseconds (negative west of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  return wallAsUtc({ ...wall, millisecond: 0 }) - (instant - wall.millisecond);
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The instant at which `timeZone` shows `wall`. An ambiguous time (clocks going back) resolves to
 * the earlier instant; a time skipped by clocks going forward resolves to the same elapsed time
 * after the gap (02:30 on the spring-forward day becomes 03:30).
 */
export function instantForWallClock(wall: WallClock, timeZone: string): number {
  const asUtc = wallAsUtc(wall);
  const day = 24 * 60 * 60 * 1000;
  const before = asUtc - offsetAt(asUtc - day, timeZone);
  const after = asUtc - offsetAt(asUtc + day, timeZone);
  const matches = [before, after]
    .filter((candidate) => sameWall(wallClockAt(candidate, timeZone), wall))
    .sort((x, y) => x - y);
  return matches[0] ?? before;
}

/**
 * One calendar month after `from`, at the same local time in `timeZone`, clamped to the last day
 * of the target month (Jan 31 → Feb 28/29). Never earlier than or equal to `from`.
 */
export function addCalendarMonth(from: Date, timeZone = 'UTC'): Date {
  const wall = wallClockAt(from.getTime(), timeZone);
  const targetYear = wall.month === 12 ? wall.year + 1 : wall.year;
  const targetMonth = wall.month === 12 ? 1 : wall.month + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return new Date(
    instantForWallClock(
      { ...wall, year: targetYear, month: targetMonth, day: Math.min(wall.day, lastDay) },
      timeZone,
    ),
  );
}
