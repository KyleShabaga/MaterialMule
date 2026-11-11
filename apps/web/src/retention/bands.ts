import type { BadgeTone } from '../components/ui';

/** Rows each Retention band loads; a fuller list is one link away in Inventory. */
export const BAND_SIZE = 50;

/** Today in the business time zone (America/Edmonton), as YYYY-MM-DD. */
export function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A calendar date `days` after `date` (both YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function endOfMonth(date: string): string {
  const [year, month] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export type BandKey = 'overdue' | 'month' | 'later';

export interface Band {
  key: BandKey;
  tag: string;
  tone: BadgeTone;
  title: string;
  from?: string;
  to: string;
}

/**
 * The three Retention bands (Field Ledger), by effective retain-until date: retention has ended
 * (on or before today, so eligible by date), ends later this month, and ends in the next 90
 * days. Each date falls in at most one band.
 */
export function retentionBands(today: string): Band[] {
  const tomorrow = addDays(today, 1);
  const monthEnd = endOfMonth(today);
  const month = new Intl.DateTimeFormat('en-CA', { month: 'long', timeZone: 'UTC' }).format(
    new Date(`${today}T00:00:00Z`),
  );
  return [
    {
      key: 'overdue',
      tag: 'Overdue',
      tone: 'danger',
      title: 'Past the end of retention',
      to: today,
    },
    {
      key: 'month',
      tag: 'This month',
      tone: 'waiting',
      title: `Ends later in ${month}`,
      from: tomorrow,
      to: monthEnd,
    },
    {
      key: 'later',
      tag: 'Next 90 days',
      tone: 'closed',
      title: 'Coming up',
      from: monthEnd < tomorrow ? tomorrow : addDays(monthEnd, 1),
      to: addDays(today, 90),
    },
  ];
}

/** The inventory query for one band: current stock, earliest retain-until first. */
export function bandParams(band: Band): URLSearchParams {
  const params = new URLSearchParams({
    status: 'current',
    sort: 'retain_until',
    pageSize: String(BAND_SIZE),
    retainUntilTo: band.to,
  });
  if (band.from) params.set('retainUntilFrom', band.from);
  return params;
}

/** Same rows in Inventory, where every filter and page is available. */
export function bandInventoryLink(band: Band): string {
  const params = bandParams(band);
  params.delete('pageSize');
  return `/sample-storage?${params.toString()}`;
}
