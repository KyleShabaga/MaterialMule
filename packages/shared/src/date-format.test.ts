import { describe, expect, it } from 'vitest';
import {
  activityTime,
  formatClockTime,
  formatRecordDate,
  inboxAge,
  labCalendarDate,
} from './date-format';

// STRATA-70. Edmonton is UTC-6 in summer. Winter cases pick instants that land on the same
// calendar date and clock under UTC-7 or UTC-6, so the tests hold for any time-zone database.

describe('record dates', () => {
  it('keeps date-only values as the calendar date they are, whatever the time zone', () => {
    expect(formatRecordDate('2026-11-11')).toBe('2026-11-11');
    expect(formatRecordDate('2026-11-11', 'medium')).toBe('Nov 11, 2026');
    expect(formatRecordDate('2026-01-01', 'medium')).toBe('Jan 1, 2026');
  });

  it("shows a timestamp's calendar date in Edmonton, across local midnight", () => {
    expect(formatRecordDate('2026-07-15T05:30:00Z')).toBe('2026-07-14');
    expect(formatRecordDate('2026-07-15T06:00:00Z')).toBe('2026-07-15');
  });

  it('handles the year boundary', () => {
    expect(formatRecordDate('2027-01-01T05:59:00Z')).toBe('2026-12-31');
    expect(formatRecordDate('2027-01-01T07:00:00Z', 'medium')).toBe('Jan 1, 2027');
  });

  it('returns nothing for missing or invalid input', () => {
    expect(formatRecordDate(null)).toBe('');
    expect(formatRecordDate('')).toBe('');
    expect(formatRecordDate('not a date')).toBe('');
    expect(labCalendarDate('nope')).toBeNull();
  });
});

describe('clock times', () => {
  it('uses AM and PM in Edmonton time across the spring DST change', () => {
    expect(formatClockTime('2026-03-08T08:59:00Z')).toBe('1:59 AM');
    expect(formatClockTime('2026-03-08T09:00:00Z')).toBe('3:00 AM');
  });

  it('shows afternoon times with PM', () => {
    expect(formatClockTime('2026-07-15T20:05:00Z')).toBe('2:05 PM');
  });
});

describe('Last 24 hours', () => {
  const now = new Date('2026-07-16T15:00:00Z'); // 9:00 AM Thursday, Jul 16

  it('labels lines before local midnight as Yesterday', () => {
    expect(activityTime('2026-07-16T05:30:00Z', now)).toEqual({
      time: '11:30 PM',
      yesterday: true,
      withinDay: true,
    });
    expect(activityTime('2026-07-16T06:05:00Z', now).yesterday).toBe(false);
  });

  it('drops lines older than 24 hours and lines in the future', () => {
    expect(activityTime('2026-07-15T15:00:00Z', now).withinDay).toBe(true);
    expect(activityTime('2026-07-15T14:59:00Z', now).withinDay).toBe(false);
    expect(activityTime('2026-07-16T15:01:00Z', now).withinDay).toBe(false);
    expect(activityTime('garbage', now).withinDay).toBe(false);
  });
});

describe('Inbox age', () => {
  const now = new Date('2026-11-12T16:00:00Z');

  it('reads Just now, minutes, then hours', () => {
    expect(inboxAge('2026-11-12T15:59:30Z', now)).toBe('Just now');
    expect(inboxAge('2026-11-12T16:00:30Z', now)).toBe('Just now');
    expect(inboxAge('2026-11-12T15:48:00Z', now)).toBe('12 min');
    expect(inboxAge('2026-11-12T13:00:00Z', now)).toBe('3 h');
  });

  it('then weekdays within six days, then the record date', () => {
    expect(inboxAge('2026-11-10T16:00:00Z', now)).toBe('Tue');
    expect(inboxAge('2026-11-06T18:00:00Z', now)).toBe('Fri');
    expect(inboxAge('2026-11-02T16:00:00Z', now)).toBe('2026-11-02');
    expect(inboxAge('2026-11-02T16:00:00Z', now, 'medium')).toBe('Nov 2, 2026');
    expect(inboxAge('bad', now)).toBe('');
  });
});
