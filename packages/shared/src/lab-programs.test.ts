import { describe, expect, it } from 'vitest';
import {
  LAB_PROGRAM_PHASES,
  LAB_PROGRAM_PHASE_TAG,
  labProgramPhase,
  labProgramSummarySchema,
} from './lab-programs';

describe('labProgramPhase (STRATA-87)', () => {
  const submitted = (
    counts: Parameters<typeof labProgramPhase>[0]['counts'],
    unitsToPull = false,
  ) => labProgramPhase({ status: 'submitted', counts, unitsToPull });

  it('follows the program status for drafts and closed programs', () => {
    expect(labProgramPhase({ status: 'draft', counts: { requested: 3 }, unitsToPull: true })).toBe(
      'draft',
    );
    expect(labProgramPhase({ status: 'closed', counts: { requested: 1 }, unitsToPull: true })).toBe(
      'closed',
    );
  });

  it('is lab work while any test is requested, in progress or completed', () => {
    expect(submitted({ requested: 1, accepted: 2 }, true)).toBe('pull');
    expect(submitted({ requested: 1, accepted: 2 }, false)).toBe('testing');
    expect(submitted({ completed: 1, review: 3 })).toBe('testing');
    expect(submitted({ in_progress: 1, review: 1 }, true)).toBe('pull');
  });

  it('is review once only tests in review remain open', () => {
    expect(submitted({ review: 1, accepted: 4, cancelled: 1 }, true)).toBe('review');
  });

  it('is ready to close when every test is accepted or cancelled with a reason', () => {
    expect(submitted({ accepted: 4, cancelled: 1 })).toBe('ready');
    expect(submitted({ cancelled: 2 })).toBe('ready');
    expect(
      labProgramPhase({
        status: 'submitted',
        counts: { accepted: 1, cancelled: 1 },
        cancelledWithoutReason: true,
        unitsToPull: false,
      }),
    ).toBe('testing');
  });

  it('never reads an empty program as ready (the empty-program closure rule)', () => {
    expect(submitted({})).toBe('testing');
  });

  it('has a tag for every phase and the summary schema accepts each phase', () => {
    for (const phase of LAB_PROGRAM_PHASES) {
      expect(LAB_PROGRAM_PHASE_TAG[phase].label).toMatch(/ · /);
      expect(labProgramSummarySchema.shape.phase.safeParse(phase).success).toBe(true);
    }
    expect(LAB_PROGRAM_PHASE_TAG.review.label).toBe('Due · Review');
    expect(LAB_PROGRAM_PHASE_TAG.ready.label).toBe('Due · Ready to close');
  });
});
