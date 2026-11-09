import { describe, expect, it } from 'vitest';
import {
  concreteStrengthAgeLines,
  concreteStrengthReportNextState,
  concreteStrengthSelfReviewUserIds,
  concreteStrengthSubmitBlocker,
  concreteStrengthSubmitRequestSchema,
} from './concrete-strength-reports';

// MM-V2-C39: the strength report's pure rules. Fictional people only.

const LEE = { userId: 'lee', initials: 'LM', name: 'Lee Manager' };
const TAY = { userId: 'tay', initials: 'TB', name: 'Taylor Bench' };

describe('concreteStrengthAgeLines', () => {
  it('one line per numeric age; complete when every non-disposed specimen is tested', () => {
    const lines = concreteStrengthAgeLines([
      { assignedAge: 28, status: 'tested' },
      { assignedAge: 7, status: 'tested' },
      { assignedAge: 28, status: 'not_yet_tested' },
      { assignedAge: 'HOLD', status: 'hold' },
      { assignedAge: 56, status: 'disposed' },
      { assignedAge: 14, status: 'tested' },
      { assignedAge: 14, status: 'disposed' },
    ]);
    expect(lines.map((l) => [l.ageDays, l.testedCount, l.complete])).toEqual([
      [7, 1, true],
      [14, 1, true],
      [28, 1, false],
      // Nothing tested: never complete, even with nothing left to test.
      [56, 0, false],
    ]);
    expect(lines.every((l) => l.averageStrength === null && l.assessment === null)).toBe(true);
  });
});

describe('concreteStrengthSubmitBlocker', () => {
  const ages = [
    { ageDays: 7, complete: true },
    { ageDays: 28, complete: false },
  ];
  it('needs the first age complete, and a new complete age after an issue', () => {
    const base = { setVoid: false, ages, state: 'not_started' as const, issuedAges: [] };
    expect(concreteStrengthSubmitBlocker(base)).toBeNull();
    expect(concreteStrengthSubmitBlocker({ ...base, setVoid: true })).toBe('set_void');
    expect(concreteStrengthSubmitBlocker({ ...base, ages: [] })).toBe('no_ages');
    expect(
      concreteStrengthSubmitBlocker({
        ...base,
        ages: [
          { ageDays: 7, complete: false },
          { ageDays: 28, complete: true },
        ],
      }),
    ).toBe('first_age_incomplete');
    expect(concreteStrengthSubmitBlocker({ ...base, state: 'issued', issuedAges: [7] })).toBe(
      'no_new_age',
    );
    expect(
      concreteStrengthSubmitBlocker({
        ...base,
        state: 'issued',
        issuedAges: [7],
        ages: [
          { ageDays: 7, complete: true },
          { ageDays: 28, complete: true },
        ],
      }),
    ).toBeNull();
    // A correction (revised back to draft) has no new-age rule.
    expect(concreteStrengthSubmitBlocker({ ...base, state: 'draft', issuedAges: [7] })).toBeNull();
  });
});

describe('concreteStrengthSelfReviewUserIds', () => {
  it('blocks the only tester and the only entrant of the reported rows', () => {
    const row = (testedBy: typeof LEE, enteredBy: (typeof LEE)[], reported = true) => ({
      reported,
      testedBy,
      enteredBy,
    });
    expect(concreteStrengthSelfReviewUserIds([row(LEE, [LEE]), row(LEE, [LEE])])).toEqual(['lee']);
    // Lee tested both, Taylor entered both: neither reviews.
    expect(concreteStrengthSelfReviewUserIds([row(LEE, [TAY]), row(LEE, [TAY])]).sort()).toEqual([
      'lee',
      'tay',
    ]);
    // Two testers and two entrants: nobody is alone.
    expect(concreteStrengthSelfReviewUserIds([row(LEE, [LEE]), row(TAY, [TAY])])).toEqual([]);
    // Unreported rows don't count.
    expect(concreteStrengthSelfReviewUserIds([row(LEE, [LEE]), row(TAY, [TAY], false)])).toEqual([
      'lee',
    ]);
    expect(concreteStrengthSelfReviewUserIds([])).toEqual([]);
  });
});

describe('strength transitions', () => {
  it('adds submit before the first version and from issued (the next age); keeps C09’s rest', () => {
    expect(concreteStrengthReportNextState('not_started', 'submit')).toBe('submitted');
    expect(concreteStrengthReportNextState('issued', 'submit')).toBe('submitted');
    expect(concreteStrengthReportNextState('issued', 'revise')).toBe('draft');
    expect(concreteStrengthReportNextState('submitted', 'recall')).toBe('draft');
    expect(concreteStrengthReportNextState('reviewed', 'submit')).toBeNull();
    expect(concreteStrengthReportNextState('not_started', 'review')).toBeNull();
  });

  it('version 0 is the request before the report exists', () => {
    const key = '7f0c2c0e-4b8e-4c43-9a51-3d7d6f1b2a10';
    expect(
      concreteStrengthSubmitRequestSchema.safeParse({ idempotencyKey: key, version: 0 }).success,
    ).toBe(true);
    expect(
      concreteStrengthSubmitRequestSchema.safeParse({ idempotencyKey: key, version: -1 }).success,
    ).toBe(false);
  });
});
