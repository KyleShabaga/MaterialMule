import { describe, expect, it } from 'vitest';
import { addCalendarMonth, hashToken } from './session.service.js';
import { readCookie } from './session-cookie.js';

describe('addCalendarMonth', () => {
  it('keeps the day and time', () => {
    expect(addCalendarMonth(new Date('2026-10-25T15:30:00Z')).toISOString()).toBe(
      '2026-11-25T15:30:00.000Z',
    );
  });

  it('clamps to the last day of a shorter month, including leap years', () => {
    expect(addCalendarMonth(new Date('2026-01-31T10:00:00Z')).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addCalendarMonth(new Date('2028-01-31T10:00:00Z')).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });

  it('rolls over the year in December', () => {
    expect(addCalendarMonth(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
});

describe('hashToken', () => {
  it('is a stable 32-byte SHA-256 that differs from the token', () => {
    const hash = hashToken('abc');
    expect(hash).toHaveLength(32);
    expect(hash.equals(hashToken('abc'))).toBe(true);
    expect(hash.toString('utf8')).not.toContain('abc');
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readCookie('a=1; trapezoid_session=tok%2Ben; b=2', 'trapezoid_session')).toBe('tok+en');
  });

  it('returns undefined when absent or malformed', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('a=1', 'x')).toBeUndefined();
    expect(readCookie('x=%E0%A4%A', 'x')).toBeUndefined();
  });
});
