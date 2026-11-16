import { describe, expect, it } from 'vitest';
import {
  CONCRETE_PROJECT_SET_PAGE_SIZE,
  concreteProjectSetQuerySchema,
  concreteProjectSetStatus,
  concreteSetSpecimenRange,
  concreteSetWorkingLabel,
} from './concrete-project-specimens';

// STRATA-98: the Sets tab's working labels and derived status. Fictional data only.

describe('concreteSetWorkingLabel / concreteSetSpecimenRange', () => {
  it('labels a set by its working number', () => {
    expect(concreteSetWorkingLabel(2)).toBe('Set 2');
  });

  it('gives the first and last specimen letters, in order', () => {
    expect(concreteSetSpecimenRange(2, ['C', 'A', 'D', 'B'])).toBe('2A–2D');
  });

  it('gives one specimen alone and nothing for none', () => {
    expect(concreteSetSpecimenRange(5, ['A'])).toBe('5A');
    expect(concreteSetSpecimenRange(5, [])).toBe('');
  });
});

describe('concreteProjectSetStatus', () => {
  const base = {
    voided: false,
    castingDate: '2026-11-01',
    testedCount: 0,
    scheduledCount: 4,
    nextTestDate: '2026-11-08',
    today: '2026-11-05',
  };

  it('is Void first, whatever else is true', () => {
    expect(concreteProjectSetStatus({ ...base, voided: true, testedCount: 4 })).toBe('void');
  });

  it('is All tested when every scheduled specimen is tested', () => {
    expect(concreteProjectSetStatus({ ...base, testedCount: 4, nextTestDate: null })).toBe(
      'tested',
    );
  });

  it('is No casting time without a casting date', () => {
    expect(concreteProjectSetStatus({ ...base, castingDate: null })).toBe('no_casting_time');
  });

  it('is On HOLD when every specimen is HOLD', () => {
    expect(concreteProjectSetStatus({ ...base, scheduledCount: 0, nextTestDate: null })).toBe(
      'on_hold',
    );
  });

  it('follows the next test date: curing, today, overdue', () => {
    expect(concreteProjectSetStatus(base)).toBe('curing');
    expect(concreteProjectSetStatus({ ...base, nextTestDate: '2026-11-05' })).toBe('due_today');
    expect(concreteProjectSetStatus({ ...base, nextTestDate: '2026-11-04' })).toBe('overdue');
    expect(concreteProjectSetStatus({ ...base, nextTestDate: null })).toBe('curing');
  });
});

describe('concreteProjectSetQuerySchema', () => {
  it('defaults the page and drops a blank search', () => {
    expect(concreteProjectSetQuerySchema.parse({ search: '  ' })).toEqual({
      page: 1,
      pageSize: CONCRETE_PROJECT_SET_PAGE_SIZE,
    });
  });

  it('refuses a page size over the maximum', () => {
    expect(concreteProjectSetQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
  });
});
