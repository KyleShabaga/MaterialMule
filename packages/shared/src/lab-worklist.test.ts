import { describe, expect, it } from 'vitest';
import { STATUS_TRANSITIONS, compareWorklist, isAllowedTransition } from './lab-worklist';
import { TEST_REQUEST_STATUSES } from './lab-programs';

describe('test status transitions (MM-T24 T1)', () => {
  it('allows only Requested → In progress → Completed → Awaiting review', () => {
    const allowed = TEST_REQUEST_STATUSES.flatMap((from) =>
      [...TEST_REQUEST_STATUSES, 'accepted']
        .filter((to) => isAllowedTransition(from, to))
        .map((to) => `${from}→${to}`),
    );
    expect(allowed).toEqual(['requested→in_progress', 'in_progress→completed', 'completed→review']);
    expect(STATUS_TRANSITIONS.review).toBeNull();
  });
});

describe('worklist order (MM-T24 T2, D52)', () => {
  it('puts Urgent first, then the oldest submission, with the ID as tie-breaker', () => {
    const rows = [
      { programId: 'b', priority: 'normal' as const, submittedAt: '2026-10-27T15:00:00.000Z' },
      { programId: 'c', priority: 'urgent' as const, submittedAt: '2026-10-27T17:00:00.000Z' },
      { programId: 'a', priority: 'normal' as const, submittedAt: '2026-10-27T16:00:00.000Z' },
      { programId: 'd', priority: 'normal' as const, submittedAt: '2026-10-27T15:00:00.000Z' },
    ];
    expect([...rows].sort(compareWorklist).map((r) => r.programId)).toEqual(['c', 'b', 'd', 'a']);
  });
});
