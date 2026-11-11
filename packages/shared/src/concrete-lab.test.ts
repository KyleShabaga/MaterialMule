import { describe, expect, it } from 'vitest';
import {
  concreteReceivingQueueQuerySchema,
  concreteSearchQuerySchema,
  concreteSearchTerms,
} from './concrete-lab';

describe('concrete search terms (MM-V2-C31)', () => {
  it('reads a set ID, a specimen ID and its letter, either alias', () => {
    expect(concreteSearchTerms('26-05')).toMatchObject({ setAlias: '26-05', letter: null });
    expect(concreteSearchTerms(' 26-05b ')).toMatchObject({ setAlias: '26-05', letter: 'B' });
    expect(concreteSearchTerms('g27-103A')).toMatchObject({ setAlias: 'G27-103', letter: 'A' });
    expect(concreteSearchTerms('tmp-d07-001')).toMatchObject({
      setAlias: 'TMP-D07-001',
      letter: null,
    });
    expect(concreteSearchTerms('TMP-D07-001C')).toMatchObject({
      setAlias: 'TMP-D07-001',
      letter: 'C',
    });
  });

  it('folds dashes and spaces, and recognises a casting date', () => {
    expect(concreteSearchTerms('26–05').setAlias).toBe('26-05');
    expect(concreteSearchTerms('Alex   Tester')).toMatchObject({
      text: 'ALEX TESTER',
      lower: 'alex tester',
      setAlias: null,
    });
    expect(concreteSearchTerms('2026-11-02').date).toBe('2026-11-02');
    expect(concreteSearchTerms('2026-13-45').date).toBeNull();
    // Impossible calendar dates are text, never a casting date (JavaScript would roll them over).
    expect(concreteSearchTerms('2026-02-30').date).toBeNull();
    expect(concreteSearchTerms('2026-04-31').date).toBeNull();
    expect(concreteSearchTerms('2026-02-29').date).toBeNull();
    expect(concreteSearchTerms('1900-02-29').date).toBeNull();
    expect(concreteSearchTerms('2026-00-10').date).toBeNull();
    expect(concreteSearchTerms('2028-02-29').date).toBe('2028-02-29');
    expect(concreteSearchTerms('2000-02-29').date).toBe('2000-02-29');
    // Review fix: PostgreSQL has no year 0; such text is searched as text only.
    expect(concreteSearchTerms('0000-01-01')).toMatchObject({ date: null, text: '0000-01-01' });
    expect(concreteSearchTerms('0000-02-29').date).toBeNull();
    expect(concreteSearchTerms('0001-01-01').date).toBe('0001-01-01');
    expect(concreteSearchTerms('2026-12-31').date).toBe('2026-12-31');
    expect(concreteSearchTerms('T-77821')).toMatchObject({ setAlias: null, date: null });
  });

  it('bounds the queries', () => {
    expect(concreteSearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(concreteSearchQuerySchema.safeParse({ q: 'x', pageSize: '51' }).success).toBe(false);
    expect(concreteSearchQuerySchema.parse({ q: ' 26-05 ' })).toMatchObject({
      q: '26-05',
      page: 1,
      pageSize: 25,
    });
    expect(concreteReceivingQueueQuerySchema.parse({})).toMatchObject({
      stage: 'awaiting_pickup',
      pageSize: 50,
    });
    expect(concreteReceivingQueueQuerySchema.safeParse({ stage: 'all' }).success).toBe(false);
  });
});
