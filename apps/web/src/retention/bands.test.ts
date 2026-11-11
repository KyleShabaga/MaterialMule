import { describe, expect, it } from 'vitest';
import { addDays, bandInventoryLink, bandParams, businessToday, retentionBands } from './bands';

describe('Retention bands (Field Ledger)', () => {
  it('splits retain-until dates into overdue, later this month and the next 90 days', () => {
    const [overdue, month, later] = retentionBands('2026-11-10');
    expect(overdue).toMatchObject({ key: 'overdue', to: '2026-11-10' });
    expect(overdue!.from).toBeUndefined();
    expect(month).toMatchObject({
      from: '2026-11-11',
      to: '2026-11-30',
      title: 'Ends later in November',
    });
    expect(later).toMatchObject({ from: '2026-12-01', to: '2027-02-08' });
  });

  it('on the last day of a month the month band is empty and the next band starts tomorrow', () => {
    const [, month, later] = retentionBands('2026-11-30');
    expect(month).toMatchObject({ from: '2026-12-01', to: '2026-11-30' });
    expect(later!.from).toBe('2026-12-01');
  });

  it('asks the inventory for current stock in retain-until order', () => {
    const [, month] = retentionBands('2026-11-10');
    expect(Object.fromEntries(bandParams(month!))).toEqual({
      status: 'current',
      sort: 'retain_until',
      pageSize: '50',
      retainUntilFrom: '2026-11-11',
      retainUntilTo: '2026-11-30',
    });
    expect(bandInventoryLink(month!)).not.toContain('pageSize');
  });

  it('counts calendar days and uses the business time zone for today', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // 03:00 UTC on 11 Nov is still 10 Nov in Edmonton.
    expect(businessToday(new Date('2026-11-11T03:00:00Z'))).toBe('2026-11-10');
  });
});
