import { describe, expect, it } from 'vitest';
import { addCalendarMonth, instantForWallClock } from './calendar-month.js';

const EDMONTON = 'America/Edmonton';
// DST examples use past transitions: time zone rules for future dates change with tzdata releases
// (Alberta's clocks stay on UTC-6 from November 2026 in tzdata 2026c).
const iso = (date: Date) => date.toISOString();

// MM-T06 T1: calendar-month expiry including the month-end clamp and DST.
describe('addCalendarMonth in the business time zone', () => {
  it('AC1: keeps the local day and time a month later', () => {
    // 2026-04-25 09:15 MDT → 2026-05-25 09:15 MDT
    expect(iso(addCalendarMonth(new Date('2026-04-25T15:15:00Z'), EDMONTON))).toBe(
      '2026-05-25T15:15:00.000Z',
    );
  });

  it('AC2: Jan 31 expires on Feb 28, or Feb 29 in a leap year, at the same time', () => {
    // 2026-01-31 14:00 MST
    expect(iso(addCalendarMonth(new Date('2026-01-31T21:00:00Z'), EDMONTON))).toBe(
      '2026-02-28T21:00:00.000Z',
    );
    expect(iso(addCalendarMonth(new Date('2028-01-31T21:00:00Z'), EDMONTON))).toBe(
      '2028-02-29T21:00:00.000Z',
    );
  });

  it('clamps by the local date, not the UTC date, late in the evening', () => {
    // 2026-01-30 23:30 MST is already Jan 31 in UTC. Locally Jan 30 → Feb 28 23:30 MST.
    expect(iso(addCalendarMonth(new Date('2026-01-31T06:30:00Z'), EDMONTON))).toBe(
      '2026-03-01T06:30:00.000Z',
    );
    // A UTC-only calculation would have ended a day early.
    expect(iso(addCalendarMonth(new Date('2026-01-31T06:30:00Z')))).toBe(
      '2026-02-28T06:30:00.000Z',
    );
  });

  it('keeps the wall-clock time across the spring DST change', () => {
    // 2026-03-01 10:00 MST → 2026-04-01 10:00 MDT (clocks went forward on Mar 8)
    expect(iso(addCalendarMonth(new Date('2026-03-01T17:00:00Z'), EDMONTON))).toBe(
      '2026-04-01T16:00:00.000Z',
    );
  });

  it('keeps the wall-clock time across the autumn DST change', () => {
    // 2025-10-15 08:00 MDT → 2025-11-15 08:00 MST (clocks went back on 2025-11-02)
    expect(iso(addCalendarMonth(new Date('2025-10-15T14:00:00Z'), EDMONTON))).toBe(
      '2025-11-15T15:00:00.000Z',
    );
  });

  it('rolls over the year and keeps milliseconds', () => {
    expect(iso(addCalendarMonth(new Date('2026-12-15T17:00:00.250Z'), EDMONTON))).toBe(
      '2027-01-15T17:00:00.250Z',
    );
  });

  it('is always later than the sign-in', () => {
    const start = Date.UTC(2026, 0, 1);
    for (let hour = 0; hour < 24 * 400; hour += 7) {
      const from = new Date(start + hour * 3_600_000);
      expect(addCalendarMonth(from, EDMONTON).getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

describe('instantForWallClock', () => {
  const wall = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 };

  it('moves a time skipped by spring-forward to just after the gap', () => {
    // 02:30 doesn't exist on 2026-03-08 in Edmonton; 03:30 MDT is 09:30Z.
    expect(new Date(instantForWallClock(wall, EDMONTON)).toISOString()).toBe(
      '2026-03-08T09:30:00.000Z',
    );
  });

  it('resolves an ambiguous fall-back time to the earlier instant', () => {
    // 01:30 happened twice on 2025-11-02; the first was 01:30 MDT = 07:30Z.
    const ambiguous = { ...wall, year: 2025, month: 11, day: 2, hour: 1 };
    expect(new Date(instantForWallClock(ambiguous, EDMONTON)).toISOString()).toBe(
      '2025-11-02T07:30:00.000Z',
    );
  });
});
