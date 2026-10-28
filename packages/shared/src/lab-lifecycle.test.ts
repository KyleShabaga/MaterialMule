import { describe, expect, it } from 'vitest';
import {
  cancelTestRequestSchema,
  closureEligibility,
  reopenProgramRequestSchema,
} from './lab-lifecycle';
import type { TestRequestStatus } from './lab-programs';

const req = (id: string, status: TestRequestStatus, cancelReason: string | null = null) => ({
  id,
  status,
  reviewState: status === 'review' ? ('returned' as const) : null,
  cancelReason: status === 'cancelled' ? cancelReason : null,
});

// MM-T26 test plan T1: closure eligibility (D06 and the empty-program rule).
describe('closure eligibility (MM-T26)', () => {
  it('never closes an empty program', () => {
    expect(closureEligibility([])).toMatchObject({
      eligible: false,
      emptyProgram: true,
      blockers: [],
    });
  });

  it('closes when every test is Accepted or Cancelled with a reason', () => {
    expect(closureEligibility([req('a', 'accepted')])).toMatchObject({
      eligible: true,
      summary: 'All tests accepted',
    });
    expect(closureEligibility([req('a', 'cancelled', 'Withdrawn')])).toMatchObject({
      eligible: true,
      summary: 'All tests cancelled with reasons',
    });
    expect(
      closureEligibility([req('a', 'accepted'), req('b', 'cancelled', 'Withdrawn')]),
    ).toMatchObject({ eligible: true, summary: 'All tests resolved' });
  });

  it('lists every unresolved test with its reason and counts', () => {
    const result = closureEligibility([
      req('a', 'requested'),
      req('b', 'in_progress'),
      req('c', 'completed'),
      req('d', 'review'),
      req('e', 'review'),
      req('f', 'cancelled', '  '),
      req('g', 'accepted'),
    ]);
    expect(result.eligible).toBe(false);
    expect(result.blockers.map((b) => [b.testRequestId, b.reason])).toEqual([
      ['a', 'requested'],
      ['b', 'in_progress'],
      ['c', 'completed'],
      ['d', 'review'],
      ['e', 'review'],
      ['f', 'cancelled_without_reason'],
    ]);
    expect(result.counts).toEqual({
      requested: 1,
      in_progress: 1,
      completed: 1,
      review: 2,
      cancelled_without_reason: 1,
    });
    expect(result.summary).toContain('2 tests still in Review');
  });

  it('requires nonblank reasons to cancel and reopen', () => {
    const base = { version: 1, idempotencyKey: '00000000-0000-4000-8000-000000000001' };
    expect(cancelTestRequestSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(reopenProgramRequestSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(reopenProgramRequestSchema.parse({ ...base, reason: '  Repeat  ' }).reason).toBe(
      'Repeat',
    );
  });
});
