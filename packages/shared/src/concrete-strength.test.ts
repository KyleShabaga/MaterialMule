import { describe, expect, it } from 'vitest';
import {
  concreteCalculationMethodLine,
  concreteP1CorrectionFactor,
  concreteStrengthAssessment,
  concreteStrengthExclusionRequestSchema,
  concreteStrengthFailed,
  concreteStrengthP1,
  concreteStrengthRelativeFlags,
  concreteStrengthTest,
  concreteStrengthTestsQuerySchema,
  roundHalfUp,
} from './concrete-strength';

// MM-V2-C24: method P1 worked examples (design page section 6). Each expected value was worked
// by hand first (shown in the comments) and cross-checked with a calculator; the tests compare
// to the reported precision (AC1, T1). Fictional readings only.

describe('roundHalfUp', () => {
  it('rounds halves up, never to even, and ignores binary representation error', () => {
    expect(roundHalfUp(25.25, 1)).toBe(25.3); // banker's rounding would give 25.2
    expect(roundHalfUp(25.35, 1)).toBe(25.4); // 25.35 is stored as 25.3499999…
    expect(roundHalfUp(0.45, 1)).toBe(0.5);
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(25.249, 1)).toBe(25.2);
    expect(roundHalfUp(17718.5, 0)).toBe(17719);
    expect(roundHalfUp(17718.49, 0)).toBe(17718);
  });
});

describe('concreteP1CorrectionFactor (L/D)', () => {
  it('uses the table points exactly', () => {
    expect(concreteP1CorrectionFactor(1.75)).toBe(0.98);
    expect(concreteP1CorrectionFactor(1.5)).toBe(0.96);
    expect(concreteP1CorrectionFactor(1.25)).toBe(0.93);
    expect(concreteP1CorrectionFactor(1.0)).toBe(0.87);
  });

  it('interpolates linearly between points', () => {
    // 1.375 is halfway from 1.25 (0.93) to 1.50 (0.96): 0.93 + 0.5 × 0.03 = 0.945.
    expect(concreteP1CorrectionFactor(1.375)).toBe(0.945);
    // 1.10: 0.87 + (0.10 / 0.25) × 0.06 = 0.87 + 0.024 = 0.894.
    expect(concreteP1CorrectionFactor(1.1)).toBe(0.894);
    // 1.70: 0.96 + (0.20 / 0.25) × 0.02 = 0.976.
    expect(concreteP1CorrectionFactor(1.7)).toBe(0.976);
  });

  it('no correction above 1.75, no strength below 1.00', () => {
    expect(concreteP1CorrectionFactor(1.76)).toBe(1);
    expect(concreteP1CorrectionFactor(2.0)).toBe(1);
    expect(concreteP1CorrectionFactor(0.99)).toBeNull();
  });
});

describe('concreteStrengthP1 (one specimen)', () => {
  it('worked example 1: 150 mm cylinder, L/D about 2, no correction', () => {
    // d̄ = (150.0 + 150.4) / 2 = 150.2 mm; h̄ = (300 + 301) / 2 = 300.5 mm.
    // A = π × 150.2² / 4 = π × 22 560.04 / 4 = 17 718.61 mm² → prints 17 719 mm².
    // L/D = 300.5 / 150.2 = 2.0007 → no correction (factor 1), within 1.00–2.20.
    // f = 450.0 kN × 1000 / 17 718.61 = 25.397 MPa → 25.4 MPa.
    const calc = concreteStrengthP1({
      maxLoad: 450,
      diameterReadings: [150.0, 150.4],
      heightReadings: [300, 301],
    })!;
    expect(calc.methodVersion).toBe('P1');
    expect(calc.provisional).toBe(true);
    expect(calc.meanDiameter).toBeCloseTo(150.2, 10);
    expect(calc.meanHeight).toBe(300.5);
    expect(calc.areaRaw).toBeCloseTo(17718.614, 3);
    expect(calc.area).toBe(17719);
    expect(calc.ldRatio).toBeCloseTo(2.0007, 4);
    expect(calc.correctionFactor).toBe(1);
    expect(calc.strengthRaw).toBeCloseTo(25.397, 3);
    expect(calc.strength).toBe(25.4);
    expect(calc.flags).toEqual([]);
  });

  it('worked example 2: L/D 1.375 interpolated (short core)', () => {
    // d̄ = 100 mm; A = π × 10 000 / 4 = 7 853.98 mm² → 7 854 mm².
    // L/D = 137.5 / 100 = 1.375 → factor 0.945.
    // f = 200 × 1000 / 7 853.98 = 25.4648 MPa × 0.945 = 24.0642 MPa → 24.1 MPa.
    const calc = concreteStrengthP1({
      maxLoad: 200,
      diameterReadings: [100],
      heightReadings: [137.5],
    })!;
    expect(calc.area).toBe(7854);
    expect(calc.correctionFactor).toBe(0.945);
    expect(calc.strengthRaw).toBeCloseTo(24.0642, 4);
    expect(calc.strength).toBe(24.1);
    // 1.375 is within 1.00–2.20: no flag (the correction itself is not unusual).
    expect(calc.flags).toEqual([]);
  });

  it('worked example 3: L/D 1.50 exactly uses 0.96', () => {
    // 25.4648 × 0.96 = 24.4462 → 24.4 MPa.
    const calc = concreteStrengthP1({
      maxLoad: 200,
      diameterReadings: [100],
      heightReadings: [150],
    })!;
    expect(calc.correctionFactor).toBe(0.96);
    expect(calc.strength).toBe(24.4);
  });

  it('review fix: exactly 2% with decimal readings is not flagged; just above is', () => {
    const flags = (diameterReadings: number[]) =>
      concreteStrengthP1({ maxLoad: 300, diameterReadings, heightReadings: [190] })!.flags;
    // 96.9 − 95.0 = 1.9 mm = exactly 2% of 95.0 (binary subtraction gives 1.9000000000000057).
    expect(flags([95.0, 96.9])).not.toContain('diameter_spread');
    expect(flags([96.9, 95.0, 96.0])).not.toContain('diameter_spread');
    // 96.91 − 95.0 = 1.91 mm > 2%.
    expect(flags([95.0, 96.91])).toContain('diameter_spread');
  });

  it('the 2% diameter flag: more than 2% flags, exactly 2% does not; values never change', () => {
    // 153.1 − 150 = 3.1 mm = 2.07% of 150 → flagged.
    const flagged = concreteStrengthP1({
      maxLoad: 450,
      diameterReadings: [150, 153.1],
      heightReadings: [300],
    })!;
    expect(flagged.flags).toEqual(['diameter_spread']);
    // The mean is still the plain mean of the readings as entered.
    expect(flagged.meanDiameter).toBeCloseTo(151.55, 10);
    // 153.0 − 150 = 3.0 mm = exactly 2% → not "more than 2%".
    const exact = concreteStrengthP1({
      maxLoad: 450,
      diameterReadings: [150, 153],
      heightReadings: [300],
    })!;
    expect(exact.flags).toEqual([]);
    // One reading can't differ from another.
    expect(
      concreteStrengthP1({ maxLoad: 450, diameterReadings: [150], heightReadings: [300] })!.flags,
    ).toEqual([]);
  });

  it('L/D below 1.00: no strength, flagged', () => {
    // 140 / 150 = 0.933.
    const calc = concreteStrengthP1({
      maxLoad: 450,
      diameterReadings: [150],
      heightReadings: [140],
    })!;
    expect(calc.correctionFactor).toBeNull();
    expect(calc.strengthRaw).toBeNull();
    expect(calc.strength).toBeNull();
    expect(calc.area).toBe(17671); // π × 150² / 4 = 17 671.46
    expect(calc.flags).toEqual(['ld_below_minimum', 'ld_out_of_range']);
  });

  it('L/D above 2.20: flagged, no correction, strength still calculated', () => {
    const calc = concreteStrengthP1({
      maxLoad: 200,
      diameterReadings: [100],
      heightReadings: [230],
    })!;
    expect(calc.flags).toEqual(['ld_out_of_range']);
    expect(calc.correctionFactor).toBe(1);
    expect(calc.strength).toBe(25.5); // 25.4648 → 25.5
  });

  it('nothing is calculated from a partial entry', () => {
    expect(
      concreteStrengthP1({ maxLoad: null, diameterReadings: [150], heightReadings: [300] }),
    ).toBeNull();
    expect(
      concreteStrengthP1({ maxLoad: 450, diameterReadings: [], heightReadings: [300] }),
    ).toBeNull();
    expect(
      concreteStrengthP1({ maxLoad: 450, diameterReadings: [150], heightReadings: [] }),
    ).toBeNull();
  });
});

describe('concreteStrengthRelativeFlags', () => {
  it('flags below 50% and above 200% of f′c', () => {
    expect(concreteStrengthRelativeFlags(12.4, 25)).toEqual(['strength_below_half_specified']);
    expect(concreteStrengthRelativeFlags(12.5, 25)).toEqual([]);
    expect(concreteStrengthRelativeFlags(50, 25)).toEqual([]);
    expect(concreteStrengthRelativeFlags(50.1, 25)).toEqual(['strength_above_double_specified']);
    expect(concreteStrengthRelativeFlags(null, 25)).toEqual([]);
    expect(concreteStrengthRelativeFlags(30, null)).toEqual([]);
  });
});

describe('concreteStrengthTest (one set, one age)', () => {
  // Three 152 mm cylinders: A = π × 152² / 4 = π × 23 104 / 4 = 18 145.84 mm².
  // 500 kN → 27.5545 MPa; 470 kN → 25.9013 MPa; 520 kN → 28.6567 MPa.
  const at = (load: number) =>
    concreteStrengthP1({ maxLoad: load, diameterReadings: [152], heightReadings: [304] })!;
  const a = at(500);
  const b = at(470);
  const c = at(520);

  it('averages the unrounded strengths of the counted specimens, then rounds', () => {
    expect([a.strength, b.strength, c.strength]).toEqual([27.6, 25.9, 28.7]);
    // (27.5545 + 25.9013 + 28.6567) / 3 = 27.3708 → 27.4.
    const test = concreteStrengthTest([a, b, c].map((s) => ({ ...s, excluded: false })))!;
    expect(test.count).toBe(3);
    expect(test.averageRaw).toBeCloseTo(27.3708, 4);
    expect(test.average).toBe(27.4);
    expect(test.single).toBe(false);
  });

  it('an excluded specimen stays out of the average', () => {
    // B excluded (e.g. defective specimen): (27.5545 + 28.6567) / 2 = 28.1056 → 28.1.
    const test = concreteStrengthTest([
      { strengthRaw: a.strengthRaw, excluded: false },
      { strengthRaw: b.strengthRaw, excluded: true },
      { strengthRaw: c.strengthRaw, excluded: false },
    ])!;
    expect(test.count).toBe(2);
    expect(test.average).toBe(28.1);
  });

  it('a single specimen is reported and marked single', () => {
    const test = concreteStrengthTest([{ strengthRaw: a.strengthRaw, excluded: false }])!;
    expect(test).toMatchObject({ count: 1, average: 27.6, single: true });
  });

  it('the average rounds half-up', () => {
    // (25.24 + 25.26) / 2 = 25.25 → 25.3 (not 25.2).
    expect(
      concreteStrengthTest([
        { strengthRaw: 25.24, excluded: false },
        { strengthRaw: 25.26, excluded: false },
      ])!.average,
    ).toBe(25.3);
  });

  it('no counted specimen (all excluded, or L/D below 1.00): no test', () => {
    expect(concreteStrengthTest([{ strengthRaw: 27, excluded: true }])).toBeNull();
    expect(concreteStrengthTest([{ strengthRaw: null, excluded: false }])).toBeNull();
    expect(concreteStrengthTest([])).toBeNull();
  });
});

describe('concreteStrengthAssessment (advisory)', () => {
  const base = { referenceAgeDays: 28, specifiedMpa: 25, previous: [] as number[] };

  it('AC3: a 7-day result is information only, however low', () => {
    expect(concreteStrengthAssessment({ ...base, ageDays: 7, average: 12.1 })).toEqual({
      assessment: 'information_only',
      runningAverage: null,
    });
    expect(concreteStrengthAssessment({ ...base, ageDays: 56, average: 40 })!.assessment).toBe(
      'information_only',
    );
  });

  it('at the reference age: below f′c − 3.5, below f′c, else meets', () => {
    const at = (average: number) =>
      concreteStrengthAssessment({ ...base, ageDays: 28, average })!.assessment;
    expect(at(21.4)).toBe('below_specified_minus_3_5');
    expect(at(21.5)).toBe('below_specified'); // exactly f′c − 3.5 is not below it
    expect(at(24.9)).toBe('below_specified');
    expect(at(25)).toBe('meets_specified');
  });

  it('review fix: the f′c − 3.5 threshold keeps the specification’s precision', () => {
    const at = (specifiedMpa: number, average: number) =>
      concreteStrengthAssessment({ ...base, specifiedMpa, ageDays: 28, average })!.assessment;
    // 25.54 − 3.5 = 22.04: a 22.0 test is more than 3.5 below (never rounded to 22.0).
    expect(at(25.54, 22.0)).toBe('below_specified_minus_3_5');
    // 25.50 − 3.5 = 22.0: the same test is exactly 3.5 below, so only below f′c.
    expect(at(25.5, 22.0)).toBe('below_specified');
    expect(at(25.54, 22.1)).toBe('below_specified');
  });

  it('running average of three, only once three exist', () => {
    // Two earlier tests: 24.0 and 25.4 (most recent first); this one 25.3.
    // (25.3 + 24.0 + 25.4) / 3 = 24.9 → below 25: flagged though each meets or is near.
    expect(
      concreteStrengthAssessment({ ...base, ageDays: 28, average: 25.3, previous: [24.0, 25.4] }),
    ).toEqual({ assessment: 'running_average_below_specified', runningAverage: 24.9 });
    // Only one earlier test: no running average yet.
    expect(
      concreteStrengthAssessment({ ...base, ageDays: 28, average: 25.3, previous: [20] }),
    ).toEqual({ assessment: 'meets_specified', runningAverage: null });
    // A test below f′c reports that first, with the running average still computed.
    expect(
      concreteStrengthAssessment({ ...base, ageDays: 28, average: 24, previous: [26, 27, 10] }),
    ).toEqual({ assessment: 'below_specified', runningAverage: 25.7 });
  });

  it('no test, or no reference age / f′c: not assessed', () => {
    expect(concreteStrengthAssessment({ ...base, ageDays: 28, average: null })).toBeNull();
    expect(
      concreteStrengthAssessment({ ...base, referenceAgeDays: null, ageDays: 28, average: 30 }),
    ).toBeNull();
    expect(
      concreteStrengthAssessment({ ...base, specifiedMpa: null, ageDays: 28, average: 30 }),
    ).toBeNull();
  });

  it('a failed result is any reference-age assessment other than meets', () => {
    expect(concreteStrengthFailed('below_specified')).toBe(true);
    expect(concreteStrengthFailed('below_specified_minus_3_5')).toBe(true);
    expect(concreteStrengthFailed('running_average_below_specified')).toBe(true);
    expect(concreteStrengthFailed('meets_specified')).toBe(false);
    expect(concreteStrengthFailed('information_only')).toBe(false);
    expect(concreteStrengthFailed(null)).toBe(false);
  });
});

describe('requests and labels', () => {
  it('prints the provisional method line', () => {
    expect(concreteCalculationMethodLine('P1', true)).toBe('Calculation method P1 (provisional)');
    expect(concreteCalculationMethodLine('W1', false)).toBe('Calculation method W1');
  });

  it('an exclusion needs a reason', () => {
    const key = '00000000-0000-4000-8000-0000000000aa';
    expect(
      concreteStrengthExclusionRequestSchema.safeParse({ idempotencyKey: key, excluded: true })
        .success,
    ).toBe(false);
    expect(
      concreteStrengthExclusionRequestSchema.safeParse({
        idempotencyKey: key,
        excluded: true,
        reason: '   ',
      }).success,
    ).toBe(false);
    expect(
      concreteStrengthExclusionRequestSchema.parse({
        idempotencyKey: key,
        excluded: true,
        reason: ' Defective specimen (end not plane) ',
      }).reason,
    ).toBe('Defective specimen (end not plane)');
  });

  it('the strength-tests read needs a set or a project', () => {
    expect(concreteStrengthTestsQuerySchema.safeParse({}).success).toBe(false);
    expect(
      concreteStrengthTestsQuerySchema.parse({
        projectId: '00000000-0000-4000-8000-0000000000aa',
        failed: 'true',
      }).failed,
    ).toBe(true);
  });
});
