import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C24: concrete compressive strength calculation and assessment, PROVISIONAL method P1
// ("V2 Concrete — Provisional report designs (G2, 2026-11-09)", section 6; owner direction
// 2026-11-09 extended to G1/G8 by the master session). Everything P1 produces is labelled
// provisional. The office worksheet, when supplied, becomes a new method version: results keep
// the version they were calculated with until someone deliberately recalculates them, with
// history (AC2).
//
// - Inputs are C07's readings as entered: max load (kN), diameter and height readings (mm).
// - Area = π × d̄² / 4 (mm², unrounded; printed to 1 mm²). Strength = load × 1000 / area (MPa),
//   times the L/D correction factor, rounded half-up to 0.1 MPa for display and assessment; the
//   unrounded value is kept too.
// - Unusual-measurement flags never change a value.
// - A strength test is the average of one set's complete, not-excluded specimens at one assigned
//   age. The assessment is advisory (never acceptance) and only at the mix's reference age.
//
// The functions here are pure, so the API (which stores the values) and the web app (which shows
// them) agree. Interpretations the page leaves open are marked "P1 reading:" and listed in
// docs/concrete.md for the owner.

/** The calculation a method version implements (the only one so far). */
export const CONCRETE_STRENGTH_METHOD = 'compressive_strength' as const;
/** The provisional method version built from the design page (section 6). */
export const CONCRETE_STRENGTH_METHOD_P1 = 'P1' as const;

/** The line printed on reports and shown with values ("Calculation method P1 (provisional)"). */
export function concreteCalculationMethodLine(version: string, provisional: boolean): string {
  return `Calculation method ${version}${provisional ? ' (provisional)' : ''}`;
}

export const concreteCalculationMethodSchema = z.object({
  method: z.string(),
  version: z.string(),
  provisional: z.boolean(),
  /** "Calculation method P1 (provisional)". */
  line: z.string(),
});
export type ConcreteCalculationMethod = z.infer<typeof concreteCalculationMethodSchema>;

// ---- Rounding ---------------------------------------------------------------------------------

/**
 * Round half away from zero (half-up for the positive values here) to `decimals` places, without
 * binary floating-point surprises: 25.25 → 25.3, 25.35 → 25.4, 1.005 (2 places) → 1.01.
 */
export function roundHalfUp(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  // 12 significant digits removes representation error (25.35 * 10 = 253.49999999999997).
  const scaled = Number((Math.abs(value) * factor).toPrecision(12));
  return (Math.sign(value) * Math.floor(scaled + 0.5)) / factor;
}

// ---- Flags ------------------------------------------------------------------------------------

/** Flags that depend on the specimen alone (stored with the calculation). */
export const CONCRETE_STRENGTH_SPECIMEN_FLAGS = [
  /** Diameter readings differ from each other by more than 2%. */
  'diameter_spread',
  /** L/D below 1.00: no strength is calculated. */
  'ld_below_minimum',
  /** L/D outside 1.00–2.20. */
  'ld_out_of_range',
] as const;
export type ConcreteStrengthSpecimenFlag = (typeof CONCRETE_STRENGTH_SPECIMEN_FLAGS)[number];

/** Flags against the mix's specified strength (read with the specification, never stored). */
export const CONCRETE_STRENGTH_RELATIVE_FLAGS = [
  'strength_below_half_specified',
  'strength_above_double_specified',
] as const;
export type ConcreteStrengthRelativeFlag = (typeof CONCRETE_STRENGTH_RELATIVE_FLAGS)[number];

export const CONCRETE_STRENGTH_FLAGS = [
  ...CONCRETE_STRENGTH_SPECIMEN_FLAGS,
  ...CONCRETE_STRENGTH_RELATIVE_FLAGS,
] as const;
export type ConcreteStrengthFlag = (typeof CONCRETE_STRENGTH_FLAGS)[number];

export const CONCRETE_STRENGTH_FLAG_LABEL: Record<ConcreteStrengthFlag, string> = {
  diameter_spread: 'Diameters differ by more than 2%',
  ld_below_minimum: 'L/D below 1.00',
  ld_out_of_range: 'L/D outside 1.00–2.20',
  strength_below_half_specified: 'Below 50% of specified strength',
  strength_above_double_specified: 'Above 200% of specified strength',
};

// ---- Method P1: one specimen --------------------------------------------------------------------

/** P1's L/D correction points (L/D → factor), ascending. Above 1.75 there is no correction. */
export const CONCRETE_P1_LD_FACTORS: readonly (readonly [number, number])[] = [
  [1.0, 0.87],
  [1.25, 0.93],
  [1.5, 0.96],
  [1.75, 0.98],
];

/**
 * P1's correction factor for an L/D ratio: interpolated linearly between the points at or below
 * 1.75, 1 (no correction) above 1.75, and null below 1.00 (no strength).
 */
export function concreteP1CorrectionFactor(ld: number): number | null {
  const points = CONCRETE_P1_LD_FACTORS;
  if (ld < points[0]![0]) return null;
  if (ld > points[points.length - 1]![0]) return 1;
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i]!;
    if (ld <= x1) {
      const [x0, y0] = points[i - 1]!;
      // Rounded to 6 places so the factor itself carries no representation noise.
      return roundHalfUp(y0 + ((ld - x0) / (x1 - x0)) * (y1 - y0), 6);
    }
  }
  return 1;
}

export interface ConcreteStrengthInputs {
  maxLoad: number | null;
  heightReadings: readonly number[];
  diameterReadings: readonly number[];
}

/** One specimen's calculated values (raw values unrounded; `strength` and `area` rounded). */
export const concreteStrengthCalculationSchema = z.object({
  methodVersion: z.string(),
  provisional: z.boolean(),
  /** Mean of the diameter / height readings (mm, unrounded). */
  meanDiameter: z.number(),
  meanHeight: z.number(),
  /** π × d̄² / 4 (mm², unrounded) and as printed (nearest 1 mm²). */
  areaRaw: z.number(),
  area: z.number(),
  ldRatio: z.number(),
  /** 1 when no correction applies; null when L/D is below 1.00 (no strength). */
  correctionFactor: z.number().nullable(),
  /** Corrected strength (MPa): unrounded, and rounded half-up to 0.1 MPa. Null below L/D 1.00. */
  strengthRaw: z.number().nullable(),
  strength: z.number().nullable(),
  flags: z.array(z.enum(CONCRETE_STRENGTH_SPECIMEN_FLAGS)),
});
export type ConcreteStrengthCalculation = z.infer<typeof concreteStrengthCalculationSchema>;

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Method P1 for one specimen. Null when the inputs are incomplete (no load, or no height or
 * diameter reading): nothing is calculated from a partial entry.
 *
 * P1 reading: "differ from each other by more than 2%" is (largest − smallest) > 2% of the
 * smallest reading, i.e. the largest pairwise difference relative to the reading it is compared
 * with. L/D below 1.00 raises both "L/D below 1.00" and "L/D outside 1.00–2.20".
 */
export function concreteStrengthP1(
  input: ConcreteStrengthInputs,
): ConcreteStrengthCalculation | null {
  if (
    input.maxLoad === null ||
    input.heightReadings.length === 0 ||
    input.diameterReadings.length === 0
  ) {
    return null;
  }
  const meanDiameter = mean(input.diameterReadings);
  const meanHeight = mean(input.heightReadings);
  const areaRaw = (Math.PI * meanDiameter * meanDiameter) / 4;
  const ldRatio = meanHeight / meanDiameter;
  const flags: ConcreteStrengthSpecimenFlag[] = [];
  const largest = Math.max(...input.diameterReadings);
  const smallest = Math.min(...input.diameterReadings);
  // (largest − smallest) / smallest > 2%, compared without division.
  if ((largest - smallest) * 100 > 2 * smallest) flags.push('diameter_spread');
  // The range check on the ratio rounded to 0.01 would hide e.g. 2.204; compare unrounded.
  if (ldRatio < 1) flags.push('ld_below_minimum');
  if (ldRatio < 1 || ldRatio > 2.2) flags.push('ld_out_of_range');
  const correctionFactor = concreteP1CorrectionFactor(ldRatio);
  const strengthRaw =
    correctionFactor === null ? null : ((input.maxLoad * 1000) / areaRaw) * correctionFactor;
  return {
    methodVersion: CONCRETE_STRENGTH_METHOD_P1,
    provisional: true,
    meanDiameter,
    meanHeight,
    areaRaw,
    area: roundHalfUp(areaRaw, 0),
    ldRatio,
    correctionFactor,
    strengthRaw,
    strength: strengthRaw === null ? null : roundHalfUp(strengthRaw, 1),
    flags,
  };
}

/** The calculators the code implements, by method version. A new version adds one here. */
export const CONCRETE_STRENGTH_CALCULATORS: Readonly<
  Record<string, (input: ConcreteStrengthInputs) => ConcreteStrengthCalculation | null>
> = {
  [CONCRETE_STRENGTH_METHOD_P1]: concreteStrengthP1,
};

/**
 * The flags against the specified strength (f′c at the reference age): below 50% or above 200%.
 * P1 reading: applied to a specimen of any age, on its rounded strength.
 */
export function concreteStrengthRelativeFlags(
  strength: number | null,
  specifiedMpa: number | null,
): ConcreteStrengthRelativeFlag[] {
  if (strength === null || specifiedMpa === null || specifiedMpa <= 0) return [];
  if (strength * 2 < specifiedMpa) return ['strength_below_half_specified'];
  if (strength > specifiedMpa * 2) return ['strength_above_double_specified'];
  return [];
}

// ---- Strength test (one set, one age) -------------------------------------------------------------

export interface ConcreteStrengthTestSpecimen {
  /** The specimen's unrounded corrected strength; null when it has none (incomplete or L/D < 1). */
  strengthRaw: number | null;
  /** Excluded by a reviewer (it stays listed, struck from the average). */
  excluded: boolean;
}

export interface ConcreteStrengthTest {
  /** Specimens averaged (complete, with a strength, not excluded). */
  count: number;
  /** Mean of their unrounded strengths, and that rounded half-up to 0.1 MPa. */
  averageRaw: number;
  average: number;
  /** Only one specimen: reported, but marked "single specimen". */
  single: boolean;
}

/**
 * The strength test of one set at one assigned age. Null when no specimen counts.
 * P1 reading: the average is taken of the unrounded specimen strengths and then rounded.
 */
export function concreteStrengthTest(
  specimens: readonly ConcreteStrengthTestSpecimen[],
): ConcreteStrengthTest | null {
  const counted = specimens
    .filter((s) => !s.excluded && s.strengthRaw !== null)
    .map((s) => s.strengthRaw!);
  if (counted.length === 0) return null;
  const averageRaw = mean(counted);
  return {
    count: counted.length,
    averageRaw,
    average: roundHalfUp(averageRaw, 1),
    single: counted.length === 1,
  };
}

// ---- Assessment (advisory) ------------------------------------------------------------------------

export const CONCRETE_STRENGTH_ASSESSMENTS = [
  'meets_specified',
  'below_specified',
  'below_specified_minus_3_5',
  'running_average_below_specified',
  'information_only',
] as const;
export type ConcreteStrengthAssessment = (typeof CONCRETE_STRENGTH_ASSESSMENTS)[number];

export const CONCRETE_STRENGTH_ASSESSMENT_LABEL: Record<ConcreteStrengthAssessment, string> = {
  meets_specified: 'Meets specified',
  below_specified: 'Below specified',
  below_specified_minus_3_5: 'Below specified − 3.5 MPa',
  running_average_below_specified: 'Running average below specified',
  information_only: 'Information only',
};

export interface ConcreteStrengthAssessmentInput {
  ageDays: number;
  /** The mix's reference age (normally 28 d) and specified strength f′c (MPa). */
  referenceAgeDays: number | null;
  specifiedMpa: number | null;
  /** This test's rounded average (MPa), or null when there is none. */
  average: number | null;
  /**
   * The rounded averages of the earlier reference-age tests on the same project and mix, most
   * recent first (only the first two are used).
   */
  previous: readonly number[];
}

export interface ConcreteStrengthAssessmentResult {
  assessment: ConcreteStrengthAssessment;
  /** The average of this and the two previous reference-age tests, once three exist. */
  runningAverage: number | null;
}

/**
 * The advisory assessment of a strength test (never acceptance). Only at the reference age: any
 * other age is "Information only" (AC3: a 7-day result is never assessed against 28 days). Null
 * when there is no test or the specification lacks the reference age or (at that age) f′c.
 *
 * At the reference age, in order: below f′c − 3.5 MPa; below f′c; the running average of three
 * (shown only once three exist) below f′c; otherwise "Meets specified".
 * P1 reading: the running average is the mean of the three rounded test values, rounded half-up.
 */
export function concreteStrengthAssessment(
  input: ConcreteStrengthAssessmentInput,
): ConcreteStrengthAssessmentResult | null {
  if (input.average === null || input.referenceAgeDays === null) return null;
  if (input.ageDays !== input.referenceAgeDays) {
    return { assessment: 'information_only', runningAverage: null };
  }
  const fc = input.specifiedMpa;
  if (fc === null) return null;
  const runningAverage =
    input.previous.length >= 2
      ? roundHalfUp((input.average + input.previous[0]! + input.previous[1]!) / 3, 1)
      : null;
  const assessment: ConcreteStrengthAssessment =
    input.average < roundHalfUp(fc - 3.5, 1)
      ? 'below_specified_minus_3_5'
      : input.average < fc
        ? 'below_specified'
        : runningAverage !== null && runningAverage < fc
          ? 'running_average_below_specified'
          : 'meets_specified';
  return { assessment, runningAverage };
}

/** A failed result (C25 consumes it): any reference-age assessment other than "Meets specified". */
export function concreteStrengthFailed(assessment: ConcreteStrengthAssessment | null): boolean {
  return (
    assessment !== null && assessment !== 'meets_specified' && assessment !== 'information_only'
  );
}

// ---- Exclusion (reviewer) -------------------------------------------------------------------------

export const CONCRETE_STRENGTH_EXCLUSION_ACTIONS = ['exclude', 'reinstate'] as const;
export type ConcreteStrengthExclusionAction = (typeof CONCRETE_STRENGTH_EXCLUSION_ACTIONS)[number];

/**
 * `PUT /api/concrete/specimens/:specimenId/strength-exclusion` (`concrete.review` on the project,
 * strength scope). `excluded: true` strikes the specimen from its strength test; false reinstates
 * it. A reason is always required.
 */
export const concreteStrengthExclusionRequestSchema = z.strictObject({
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
  excluded: z.boolean({ error: 'Say whether to exclude or reinstate' }),
  reason: z
    .string({ error: 'Enter a reason' })
    .trim()
    .min(1, { error: 'Enter a reason' })
    .max(2000, { error: 'at most 2000 characters' }),
});
export type ConcreteStrengthExclusionRequest = z.input<
  typeof concreteStrengthExclusionRequestSchema
>;

export const concreteStrengthExclusionSchema = z.object({
  reason: z.string(),
  by: personSnapshotSchema,
  at: z.string(),
});
export type ConcreteStrengthExclusion = z.infer<typeof concreteStrengthExclusionSchema>;

export const concreteStrengthExclusionEventSchema = z.object({
  sequenceNo: z.number().int(),
  action: z.enum(CONCRETE_STRENGTH_EXCLUSION_ACTIONS),
  reason: z.string(),
  by: personSnapshotSchema,
  at: z.string(),
});
export type ConcreteStrengthExclusionEvent = z.infer<typeof concreteStrengthExclusionEventSchema>;

/** `GET|PUT /api/concrete/specimens/:specimenId/strength-exclusion`. */
export const concreteStrengthExclusionStateSchema = z.object({
  specimenId: z.string(),
  /** The current exclusion (null: counted in its strength test). */
  excluded: concreteStrengthExclusionSchema.nullable(),
  history: z.array(concreteStrengthExclusionEventSchema),
});
export type ConcreteStrengthExclusionState = z.infer<typeof concreteStrengthExclusionStateSchema>;

// ---- Strength tests read (C25 consumes "failed") --------------------------------------------------

export const concreteStrengthTestSpecimenSchema = z.object({
  specimenId: z.string(),
  letter: z.string(),
  resultId: z.string().nullable(),
  /** The latest attempt's entry is complete. */
  complete: z.boolean(),
  calculation: concreteStrengthCalculationSchema.nullable(),
  /** Specimen and specified-strength flags together. */
  flags: z.array(z.enum(CONCRETE_STRENGTH_FLAGS)),
  excluded: concreteStrengthExclusionSchema.nullable(),
  /** Counted in the average (complete, with a strength, not excluded). */
  counted: z.boolean(),
});
export type ConcreteStrengthTestSpecimenRow = z.infer<typeof concreteStrengthTestSpecimenSchema>;

export const concreteStrengthTestLineSchema = z.object({
  setId: z.string(),
  ageDays: z.number().int(),
  /** Every specimen of the age (not disposed) has a complete entry. */
  complete: z.boolean(),
  /** The latest test date among the counted specimens (orders the running average). */
  testedOn: z.string().nullable(),
  specimens: z.array(concreteStrengthTestSpecimenSchema),
  /** The test (null until the age is complete and a specimen counts). */
  count: z.number().int(),
  averageRaw: z.number().nullable(),
  average: z.number().nullable(),
  single: z.boolean(),
  referenceAge: z.boolean(),
  assessment: z.enum(CONCRETE_STRENGTH_ASSESSMENTS).nullable(),
  runningAverage: z.number().nullable(),
  /** Any reference-age assessment other than "Meets specified" (C25). */
  failed: z.boolean(),
  /** The method versions of the counted specimens (normally one). */
  methodVersions: z.array(z.string()),
});
export type ConcreteStrengthTestLine = z.infer<typeof concreteStrengthTestLineSchema>;

/** `GET /api/concrete/strength-tests?setId=…|projectId=…[&failed=true]` (`inventory.read`). */
export const concreteStrengthTestsQuerySchema = z
  .strictObject({
    setId: z.uuid({ error: 'must be an ID' }).optional(),
    projectId: z.uuid({ error: 'must be an ID' }).optional(),
    failed: z
      .enum(['true', 'false'], { error: 'Use true or false' })
      .transform((value) => value === 'true')
      .default(false),
  })
  .refine((q) => q.setId !== undefined || q.projectId !== undefined, {
    error: 'Choose a set or a project',
    path: ['setId'],
  });
export type ConcreteStrengthTestsQuery = z.output<typeof concreteStrengthTestsQuerySchema>;

/** Sets per project-wide response; the response says when there are more. */
export const CONCRETE_STRENGTH_TESTS_MAX_SETS = 500;

export const concreteStrengthTestsSchema = z.object({
  method: concreteCalculationMethodSchema.nullable(),
  truncated: z.boolean(),
  tests: z.array(concreteStrengthTestLineSchema),
});
export type ConcreteStrengthTests = z.infer<typeof concreteStrengthTestsSchema>;
