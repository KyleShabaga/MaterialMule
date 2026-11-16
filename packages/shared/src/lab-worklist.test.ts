import { describe, expect, it } from 'vitest';
import {
  STATUS_TRANSITIONS,
  WORKBOARD_COLUMNS,
  WORKBOARD_COLUMN_LABEL,
  WORKBOARD_COLUMN_TAG,
  compareWorklist,
  isAllowedTransition,
  workboardColumn,
} from './lab-worklist';
import { TEST_REQUEST_STATUSES, type TestRequestStatus } from './lab-programs';

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

describe('Workboard column (STRATA-88)', () => {
  const place = (counts: Partial<Record<TestRequestStatus, number>>, unitsToPull = 0) =>
    workboardColumn({ counts, unitsToPull });

  it('puts open lab work in Units to pull or In testing, before Review (labProgramPhase)', () => {
    expect(place({ review: 1, requested: 3 }, 2)).toBe('pull');
    expect(place({ review: 1, in_progress: 1 })).toBe('testing');
    expect(place({ requested: 2 }, 1)).toBe('pull');
    expect(place({ completed: 1, accepted: 4 })).toBe('testing');
  });

  it('puts a program whose only unfinished tests are in Review in Waiting for review', () => {
    expect(place({ review: 1, accepted: 2 })).toBe('review');
    // Units left in storage don't matter once no lab work is open.
    expect(place({ review: 1 }, 3)).toBe('review');
  });

  it('puts an empty program, or one with a cancellation lacking a reason, in In testing', () => {
    expect(place({})).toBe('testing');
    expect(
      workboardColumn({ counts: { cancelled: 1 }, unitsToPull: 0, cancelledWithoutReason: true }),
    ).toBe('testing');
  });

  it('puts a program whose tests are all accepted or cancelled in Ready to close', () => {
    expect(place({ accepted: 3 })).toBe('ready');
    expect(place({ accepted: 1, cancelled: 2 })).toBe('ready');
    expect(place({ cancelled: 1 })).toBe('ready');
  });

  it('has a column label and a "<Stage> · <domain>" tag for every column', () => {
    for (const column of WORKBOARD_COLUMNS) {
      expect(WORKBOARD_COLUMN_LABEL[column]).toBeTruthy();
      expect(WORKBOARD_COLUMN_TAG[column].label).toMatch(/^(Due|In lab) · /);
    }
  });
});
