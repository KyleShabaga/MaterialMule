// Dates and times on the dashboard, in the lab's time zone (America/Edmonton).

const ZONE = 'America/Edmonton';

const DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** The lab's calendar date of an instant, as YYYY-MM-DD. */
export function labDate(at: Date): string {
  return DAY.format(at);
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * When a storage unit was received: the time for today ("2:32 p.m."), "Yesterday", or the date
 * ("2026-10-22"). The received date is what people entered; the confirmation time is only shown
 * when it falls on that date (a receipt entered later for an earlier day shows just the day).
 */
export function receivedWhen(receivedDate: string, receivedAt: string, now = new Date()): string {
  const today = labDate(now);
  if (receivedDate === today) {
    return labDate(new Date(receivedAt)) === today ? TIME.format(new Date(receivedAt)) : 'Today';
  }
  if (receivedDate === dayBefore(today)) return 'Yesterday';
  return receivedDate;
}

/** "Oct 26, 2:05 p.m." for the activity list and drafts. */
export function shortDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** "2:05 p.m.": the time of day of an instant in the lab's time zone. */
export function shortTime(iso: string): string {
  return TIME.format(new Date(iso));
}
