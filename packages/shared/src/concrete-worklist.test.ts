import { describe, expect, it } from 'vitest';
import {
  CONCRETE_HOLIDAY_CALENDAR,
  concreteDaysBetween,
  concreteLabToday,
  concreteRescheduleRequestSchema,
  concreteRescheduledTarget,
  concreteWorklistFlags,
  concreteWorklistQuerySchema,
  concreteWorklistViewOf,
} from './concrete-worklist';
import { concreteSpecimenDates } from './concrete-specimen-sets';

// MM-V2-C22 T1: target / overdue / HOLD date maths, including the year boundary. America/Edmonton
// is UTC−6 all year in tzdata 2026c; times are written in local time.

const view = (
  assignedAge: number | 'HOLD',
  targetDate: string | null,
  holdExpiresOn: string | null,
  today: string,
) => concreteWorklistViewOf({ assignedAge, targetDate, holdExpiresOn, today });

describe('concrete lab worklist dates (MM-V2-C22)', () => {
  it('reads today as the America/Edmonton business date, not the UTC date', () => {
    // 23:30 local on 31 Dec is already 1 Jan in UTC.
    expect(concreteLabToday(new Date('2026-12-31T23:30:00-06:00'))).toBe('2026-12-31');
    expect(concreteLabToday(new Date('2027-01-01T00:10:00-06:00'))).toBe('2027-01-01');
  });

  it('counts calendar days across a year boundary', () => {
    expect(concreteDaysBetween('2026-12-28', '2027-01-04')).toBe(7);
    expect(concreteDaysBetween('2027-01-04', '2026-12-28')).toBe(-7);
    expect(concreteDaysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('puts a target in Today, Overdue or the next seven days, never shifting it', () => {
    expect(view(28, '2026-11-30', null, '2026-11-30')).toBe('today');
    expect(view(28, '2026-11-29', null, '2026-11-30')).toBe('overdue');
    expect(view(28, '2026-12-01', null, '2026-11-30')).toBe('upcoming');
    expect(view(28, '2026-12-07', null, '2026-11-30')).toBe('upcoming');
    expect(view(28, '2026-12-08', null, '2026-11-30')).toBeNull();
    // Year boundary: 28 Dec + 7 = 4 Jan is still upcoming; 5 Jan is not.
    expect(view(7, '2027-01-04', null, '2026-12-28')).toBe('upcoming');
    expect(view(7, '2027-01-05', null, '2026-12-28')).toBeNull();
    expect(view(7, '2026-12-31', null, '2027-01-02')).toBe('overdue');
  });

  it('AC1: a 28-day target on a Saturday stays on Saturday with a weekend flag', () => {
    // Cast Saturday 7 Nov 2026 → 28 days is Saturday 5 Dec 2026.
    const dates = concreteSpecimenDates({
      castAt: '2026-11-07T08:00:00-06:00',
      age: 28,
      holdDurationDays: 56,
    });
    expect(dates.targetDate).toBe('2026-12-05');
    const flags = concreteWorklistFlags({
      assignedAge: 28,
      targetDate: dates.targetDate,
      holdExpiresOn: null,
      today: '2026-12-05',
      rescheduleCount: 0,
      reportState: 'submitted',
    });
    expect(flags).toEqual(['weekend_target']);
    expect(view(28, dates.targetDate, null, '2026-12-05')).toBe('today');
    // Holidays: no calendar defined yet (open owner input), so none is flagged.
    expect(CONCRETE_HOLIDAY_CALENDAR).toBeNull();
  });

  it('AC2: an untested specimen past its target is overdue and keeps the same target', () => {
    const flags = concreteWorklistFlags({
      assignedAge: 7,
      targetDate: '2026-11-09',
      holdExpiresOn: null,
      today: '2026-11-12',
      rescheduleCount: 0,
      reportState: 'submitted',
    });
    expect(flags).toEqual(['overdue']);
  });

  it('AC3: HOLD is always in HOLD and flags review on and after the hold-until date only', () => {
    expect(view('HOLD', null, '2026-12-28', '2026-11-30')).toBe('hold');
    const flagsOn = (today: string) =>
      concreteWorklistFlags({
        assignedAge: 'HOLD',
        targetDate: null,
        holdExpiresOn: '2026-12-28',
        today,
        rescheduleCount: 0,
        reportState: 'submitted',
      });
    expect(flagsOn('2026-12-27')).toEqual([]);
    expect(flagsOn('2026-12-28')).toEqual(['hold_review_due']);
    expect(flagsOn('2027-01-03')).toEqual(['hold_review_due']);
    // HOLD expiry crosses the year: cast 15 Nov 2026 + 56 days = 10 Jan 2027.
    expect(
      concreteSpecimenDates({
        castAt: '2026-11-15T16:00:00-06:00',
        age: 'HOLD',
        holdDurationDays: 56,
      }).holdExpiresOn,
    ).toBe('2027-01-10');
  });

  it('a specimen with no casting date is in no view', () => {
    expect(view(28, null, null, '2026-11-30')).toBeNull();
    expect(view('HOLD', null, null, '2026-11-30')).toBeNull();
  });

  it('a reschedule target is casting date + the new age, across the year', () => {
    expect(concreteRescheduledTarget('2026-12-10', 56)).toBe('2027-02-04');
    expect(concreteRescheduledTarget('2026-11-02', 28)).toBe('2026-11-30');
  });

  it('validates the worklist query and the reschedule request', () => {
    expect(concreteWorklistQuerySchema.parse({})).toEqual({
      view: 'today',
      holdDue: false,
      page: 1,
    });
    // MM-V2-C31: the HOLD-due list behind the dashboard count.
    expect(concreteWorklistQuerySchema.parse({ view: 'hold', holdDue: 'true' }).holdDue).toBe(true);
    expect(concreteWorklistQuerySchema.safeParse({ holdDue: 'yes' }).success).toBe(false);
    expect(concreteWorklistQuerySchema.safeParse({ view: 'later' }).success).toBe(false);
    expect(concreteWorklistQuerySchema.parse({ view: 'hold', page: '2' }).page).toBe(2);
    const ok = {
      idempotencyKey: '7b2f2d1e-5c1a-4b9e-9a1c-2f0e8d6c4b3a',
      version: 1,
      newAge: 56,
      reason: 'Engineer asked for a 56-day break',
    };
    expect(concreteRescheduleRequestSchema.safeParse(ok).success).toBe(true);
    expect(concreteRescheduleRequestSchema.safeParse({ ...ok, reason: '  ' }).success).toBe(false);
    expect(concreteRescheduleRequestSchema.safeParse({ ...ok, newAge: 'HOLD' }).success).toBe(
      false,
    );
    expect(concreteRescheduleRequestSchema.safeParse({ ...ok, newAge: 0 }).success).toBe(false);
    expect(concreteRescheduleRequestSchema.safeParse({ ...ok, newAge: 1000 }).success).toBe(false);
  });
});
