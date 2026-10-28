import { describe, expect, it } from 'vitest';
import {
  REVIEW_STATES,
  nextReviewState,
  reviewDecisionRequestSchema,
  type ReviewAction,
} from './lab-review';

// MM-T25 test plan T1: review sub-state transitions, valid only.
describe('review sub-state transitions (MM-T25)', () => {
  it('allows exactly the confirmed moves', () => {
    const actions: ReviewAction[] = ['complete', 'return', 'correction_done'];
    const allowed = REVIEW_STATES.flatMap((from) =>
      actions
        .map((action) => [from, action, nextReviewState(from, action)] as const)
        .filter(([, , to]) => to !== null),
    );
    expect(allowed).toEqual([
      ['awaiting_review', 'complete', 'review_complete'],
      ['awaiting_review', 'return', 'returned'],
      ['returned', 'correction_done', 'correction_done'],
      ['correction_done', 'complete', 'review_complete'],
      ['correction_done', 'return', 'returned'],
    ]);
  });

  it('leaves the unresolved Review complete → Returned edge refused', () => {
    expect(nextReviewState('review_complete', 'return')).toBeNull();
    expect(nextReviewState('review_complete', 'complete')).toBeNull();
  });

  it('requires a nonblank comment to return, and trims it', () => {
    const base = { version: 1, idempotencyKey: '00000000-0000-4000-8000-000000000001' };
    expect(reviewDecisionRequestSchema.safeParse({ ...base, action: 'return' }).success).toBe(
      false,
    );
    expect(
      reviewDecisionRequestSchema.safeParse({ ...base, action: 'return', comment: '  ' }).success,
    ).toBe(false);
    expect(
      reviewDecisionRequestSchema.parse({ ...base, action: 'return', comment: ' Fix it ' }).comment,
    ).toBe('Fix it');
    expect(reviewDecisionRequestSchema.parse({ ...base, action: 'complete' }).comment).toBeNull();
  });
});
