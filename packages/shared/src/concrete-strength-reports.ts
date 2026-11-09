import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import {
  CONCRETE_REPORT_ACTIONS,
  CONCRETE_REPORT_TRANSITIONS,
  concreteReportVersionSummarySchema,
  type ConcreteReportAction,
  type ConcreteReportLifecycleState,
} from './concrete-report-lifecycle';
import {
  CONCRETE_TEST_RESULT_DIMENSION_UNITS,
  CONCRETE_TEST_RESULT_LOAD_UNITS,
} from './concrete-test-results';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C39: concrete compressive strength reports (provisional design, G2 owner direction
// 2026-11-09, section 4). One report per specimen set, cumulative:
//
// - It can be submitted once the set's first test age is complete (every specimen of that age,
//   other than a disposed one, has a complete C23 entry: `concreteTestEntryComplete`).
// - Each later age is a revision of the same report (the next version after an issue), so the
//   latest revision shows every age tested so far. A correction to an issued result needs a
//   revision too (C09's revise, then submit).
// - Lifecycle, audit, frozen snapshots with SHA-256, routing and permissions are C09's; review is
//   `concrete.review` and issue `report.issue` for the `concrete_strength` scope.
// - No self-review: the only tester, or the only person credited with entering, the results a
//   version shows never reviews or issues it (as a field report's technician never does).
// - Strength, area, the per-age average and the assessment are null until C24 delivers the
//   approved method (G1 / G8). Average diameter and height stay null too: the number of readings,
//   corrections and rounding are G8's. Readings and the maximum load print as entered.

const idSchema = z.uuid({ error: 'must be an ID' });

/** The review / issue scope of a strength report (MISC-08 / AO03 scope code). */
export const STRENGTH_REPORT_SCOPE = 'concrete_strength';

/** Design section 4: the standards line until the owner names the methods. */
export const CONCRETE_STRENGTH_STANDARDS_LINE = 'Test methods: [to be confirmed by owner]';

// ---- Exceptions (reviewed with C28's checklist) ---------------------------------------------------

export const CONCRETE_STRENGTH_REPORT_WARNINGS = [
  /** Tested on a date other than its target date (actual age differs from assigned age). */
  'strength_tested_off_target',
  /** Past its target date at submission with no complete entry, not HOLD, not disposed. */
  'strength_overdue_untested',
] as const;
export type ConcreteStrengthReportWarningCode = (typeof CONCRETE_STRENGTH_REPORT_WARNINGS)[number];

export const concreteStrengthReportWarningSchema = z.object({
  code: z.enum(CONCRETE_STRENGTH_REPORT_WARNINGS),
  /** `results.<letter>`: the specimen row it concerns. */
  field: z.string().nullable(),
  message: z.string(),
});
export type ConcreteStrengthReportWarning = z.infer<typeof concreteStrengthReportWarningSchema>;

export const CONCRETE_STRENGTH_WARNING_MESSAGE: Record<ConcreteStrengthReportWarningCode, string> =
  {
    strength_tested_off_target: 'Tested on a date other than its target date',
    strength_overdue_untested: 'Past its target date with no complete test entry',
  };

// ---- Frozen version snapshot (design section 4) ---------------------------------------------------

export const CONCRETE_STRENGTH_ROW_STATUSES = [
  'tested',
  'not_yet_tested',
  'hold',
  'disposed',
] as const;
export type ConcreteStrengthRowStatus = (typeof CONCRETE_STRENGTH_ROW_STATUSES)[number];

/** One row per specimen. Null is "—" on the report: never 0 or No for a missing value. */
export const concreteStrengthResultRowSchema = z.object({
  specimenId: z.string(),
  letter: z.string(),
  /** Set ID + letter (permanent, else temporary). */
  specimenLabel: z.string(),
  identity: concreteSpecimenIdentitySchema,
  /** Days, or 'HOLD', or null when no age was assigned. */
  assignedAge: z.union([z.number(), z.literal('HOLD')]).nullable(),
  targetDate: z.string().nullable(),
  status: z.enum(CONCRETE_STRENGTH_ROW_STATUSES),
  /**
   * The row's complete entry is part of this version ("tested"). The database locks these
   * results while the version is submitted, reviewed or issued.
   */
  reported: z.boolean(),
  resultId: z.string().nullable(),
  attemptNo: z.number().nullable(),
  testedOn: z.string().nullable(),
  actualAgeDays: z.number().nullable(),
  heightReadings: z.array(z.number()),
  diameterReadings: z.array(z.number()),
  /** G8 (readings, corrections, rounding): null until C24. */
  averageDiameter: z.null(),
  averageHeight: z.null(),
  area: z.null(),
  maxLoad: z.number().nullable(),
  /** G1 / G8: null until C24. */
  strength: z.null(),
  /** Not recorded by C07 yet: null prints "—". */
  fractureType: z.string().nullable(),
  testedBy: personSnapshotSchema.nullable(),
  /** Everyone credited with entering or correcting this result (never the LAB account). */
  enteredBy: z.array(personSnapshotSchema),
  remarks: z.string().nullable(),
});
export type ConcreteStrengthResultRow = z.infer<typeof concreteStrengthResultRowSchema>;

export const concreteStrengthAgeLineSchema = z.object({
  ageDays: z.number(),
  specimenCount: z.number(),
  testedCount: z.number(),
  /** Every specimen of the age (not disposed) has a complete entry. */
  complete: z.boolean(),
  /** G1 / G8: null until C24. */
  averageStrength: z.null(),
  assessment: z.null(),
});
export type ConcreteStrengthAgeLine = z.infer<typeof concreteStrengthAgeLineSchema>;

export const concreteStrengthSetBlockSchema = z.object({
  setId: z.string(),
  identity: concreteSpecimenIdentitySchema,
  fieldReportId: z.string(),
  /** CF-YYYY-NNNNN once the field report is issued with a number (C32); null until then. */
  fieldReportNumber: z.string().nullable(),
  paperFieldId: z.string().nullable(),
  castAt: z.string().nullable(),
  castingDate: z.string().nullable(),
  structureElements: z.array(z.string()),
  structureElementOther: z.string().nullable(),
  location: z.string().nullable(),
  supplierName: z.string().nullable(),
  mixNumber: z.string().nullable(),
  specifiedStrengthMpa: z.number().nullable(),
  specifiedStrengthAgeDays: z.number().nullable(),
  specimenType: z.string(),
  specimenSize: z.string().nullable(),
  /** Earliest lab receipt of a specimen of the set (America/Edmonton date). */
  receivedOn: z.string().nullable(),
  /** As recorded at pickup (curing box / location), else null. */
  initialFieldCuring: z.string().nullable(),
  /** Not recorded yet (no lab-curing record): null prints "—". */
  labCuring: z.string().nullable(),
});
export type ConcreteStrengthSetBlock = z.infer<typeof concreteStrengthSetBlockSchema>;

/**
 * What a strength report version freezes (C32's renderer prints it). The report number, issue
 * date and sign-off come from the version / report record at issue, not from here.
 */
export const concreteStrengthReportSnapshotSchema = z.object({
  kind: z.literal('strength'),
  versionNo: z.number(),
  /** "Rev n": 0 for the first issue, then one more for each issued revision. */
  revNo: z.number(),
  /** Set when this version revises an issued one ("Rev n, supersedes Rev n-1 issued …"). */
  revision: z
    .object({
      supersedesVersionNo: z.number(),
      supersedesRevNo: z.number(),
      supersedesIssuedAt: z.string(),
      reason: z.string(),
    })
    .nullable(),
  reportId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  client: z.string().nullable(),
  leadProjectEngineer: personSnapshotSchema.nullable(),
  set: concreteStrengthSetBlockSchema,
  units: z.object({
    load: z.enum(CONCRETE_TEST_RESULT_LOAD_UNITS),
    dimension: z.enum(CONCRETE_TEST_RESULT_DIMENSION_UNITS),
    provisional: z.boolean(),
  }),
  results: z.array(concreteStrengthResultRowSchema),
  ages: z.array(concreteStrengthAgeLineSchema),
  /** The complete ages this version reports (cumulative). */
  agesReported: z.array(z.number()),
  warnings: z.array(concreteStrengthReportWarningSchema),
  standardsLine: z.string(),
  /** Why strength values are blank: the method isn't approved yet (C24, G1/G8). */
  calculation: z.object({ method: z.null(), note: z.string() }),
});
export type ConcreteStrengthReportSnapshot = z.infer<typeof concreteStrengthReportSnapshotSchema>;

export const CONCRETE_STRENGTH_CALCULATION_NOTE =
  'Strength, area, averages and assessment await the approved method (C24; owner gates G1/G8).';

// ---- Pure rules (API and web agree) ---------------------------------------------------------------

/** The age lines of a set: one per numeric assigned age, ascending. */
export function concreteStrengthAgeLines(
  rows: readonly Pick<ConcreteStrengthResultRow, 'assignedAge' | 'status'>[],
): ConcreteStrengthAgeLine[] {
  const ages = new Map<number, { count: number; tested: number; open: number }>();
  for (const row of rows) {
    if (typeof row.assignedAge !== 'number') continue;
    const line = ages.get(row.assignedAge) ?? { count: 0, tested: 0, open: 0 };
    line.count += 1;
    if (row.status === 'tested') line.tested += 1;
    else if (row.status !== 'disposed') line.open += 1;
    ages.set(row.assignedAge, line);
  }
  return [...ages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ageDays, line]) => ({
      ageDays,
      specimenCount: line.count,
      testedCount: line.tested,
      complete: line.tested > 0 && line.open === 0,
      averageStrength: null,
      assessment: null,
    }));
}

export const CONCRETE_STRENGTH_SUBMIT_BLOCKERS = [
  'set_void',
  'no_ages',
  'first_age_incomplete',
  'no_new_age',
] as const;
export type ConcreteStrengthSubmitBlocker = (typeof CONCRETE_STRENGTH_SUBMIT_BLOCKERS)[number];

export const CONCRETE_STRENGTH_SUBMIT_BLOCKER_MESSAGE: Record<
  ConcreteStrengthSubmitBlocker,
  string
> = {
  set_void: 'The set is Void',
  no_ages: 'The set has no specimens with a test age',
  first_age_incomplete: 'Every specimen of the first test age needs a complete entry',
  no_new_age: 'No test age has been completed since the last issue',
};

/**
 * Whether a strength report may be submitted now. The first age must be complete; after an issue
 * (a cumulative revision) a complete age the last issued version didn't report is needed too.
 * A correction after issue goes through revise (back to draft), which has no new-age rule.
 */
export function concreteStrengthSubmitBlocker(input: {
  setVoid: boolean;
  ages: readonly Pick<ConcreteStrengthAgeLine, 'ageDays' | 'complete'>[];
  /** Lifecycle state now ('issued': the next age is a revision). */
  state: ConcreteReportLifecycleState | 'not_started';
  /** The ages the latest issued version reported (empty before the first issue). */
  issuedAges: readonly number[];
}): ConcreteStrengthSubmitBlocker | null {
  if (input.setVoid) return 'set_void';
  if (input.ages.length === 0) return 'no_ages';
  if (!input.ages[0]!.complete) return 'first_age_incomplete';
  if (input.state === 'issued') {
    const issued = new Set(input.issuedAges);
    if (!input.ages.some((age) => age.complete && !issued.has(age.ageDays))) return 'no_new_age';
  }
  return null;
}

/**
 * Who may not review or issue a version (no self-review, owner decision 2026-11-08 applied to
 * strength reports): the only tester of its reported results, and the only person credited with
 * entering them. Two or more people on either side block nobody on that side.
 */
export function concreteStrengthSelfReviewUserIds(
  results: readonly Pick<ConcreteStrengthResultRow, 'reported' | 'testedBy' | 'enteredBy'>[],
): string[] {
  const reported = results.filter((row) => row.reported);
  const testers = new Set(reported.flatMap((row) => (row.testedBy ? [row.testedBy.userId] : [])));
  const entrants = new Set(reported.flatMap((row) => row.enteredBy.map((p) => p.userId)));
  const out = new Set<string>();
  if (testers.size === 1) out.add([...testers][0]!);
  if (entrants.size === 1) out.add([...entrants][0]!);
  return [...out];
}

/**
 * The confirmed transitions for a strength report: C09's, plus submit from issued (the next age,
 * a cumulative revision). Before the first submission there is no report row ('not_started').
 */
export const CONCRETE_STRENGTH_REPORT_TRANSITIONS: Readonly<
  Record<
    ConcreteReportLifecycleState | 'not_started',
    Partial<Record<ConcreteReportAction, ConcreteReportLifecycleState>>
  >
> = {
  ...CONCRETE_REPORT_TRANSITIONS,
  not_started: { submit: 'submitted' },
  issued: { ...CONCRETE_REPORT_TRANSITIONS.issued, submit: 'submitted' },
};

export function concreteStrengthReportNextState(
  state: ConcreteReportLifecycleState | 'not_started',
  action: ConcreteReportAction,
): ConcreteReportLifecycleState | null {
  return CONCRETE_STRENGTH_REPORT_TRANSITIONS[state][action] ?? null;
}

// ---- Requests -------------------------------------------------------------------------------------

const commentSchema = z
  .string()
  .trim()
  .min(1, { error: 'enter a comment' })
  .max(2000, { error: 'at most 2000 characters' });

const strengthCommandBase = {
  idempotencyKey: idSchema,
  /** The strength report's version; 0 before the first submission (no report yet). */
  version: z.int().min(0),
};

/** Submit / resubmit / recall: LAB names the performing staff member. */
export const concreteStrengthSubmitRequestSchema = z.strictObject({
  ...strengthCommandBase,
  performedByUserId: idSchema.optional(),
});
export type ConcreteStrengthSubmitRequest = z.input<typeof concreteStrengthSubmitRequestSchema>;

/** Review: an optional note. */
export const concreteStrengthCommandRequestSchema = z.strictObject({
  ...strengthCommandBase,
  comment: commentSchema.optional(),
});
export type ConcreteStrengthCommandRequest = z.input<typeof concreteStrengthCommandRequestSchema>;

/** Return for correction and revise after issue: the reason is required. */
export const concreteStrengthCommentRequiredSchema = z.strictObject({
  ...strengthCommandBase,
  comment: commentSchema,
});

// ---- Responses ------------------------------------------------------------------------------------

export const CONCRETE_STRENGTH_REPORT_STATES = [
  'not_started',
  'draft',
  'submitted',
  'returned',
  'reviewed',
  'issued',
] as const;
export type ConcreteStrengthReportState = (typeof CONCRETE_STRENGTH_REPORT_STATES)[number];

export const CONCRETE_STRENGTH_REPORT_STATE_LABEL: Record<ConcreteStrengthReportState, string> = {
  not_started: 'Not submitted',
  draft: 'Draft',
  submitted: 'Awaiting review',
  returned: 'Returned for correction',
  reviewed: 'Reviewed awaiting issuance',
  issued: 'Issued',
};

/** `GET /api/concrete/specimen-sets/:setId/strength-report`. */
export const concreteStrengthReportDetailSchema = z.object({
  setId: z.string(),
  projectId: z.string(),
  /** Null before the first submission. */
  reportId: z.string().nullable(),
  reportNumber: z.string().nullable(),
  state: z.enum(CONCRETE_STRENGTH_REPORT_STATES),
  /** The report row's version (0 before the first submission): send it with each command. */
  version: z.number(),
  issueCount: z.number(),
  revised: z.boolean(),
  /** The report as it would be submitted now (live data; nothing frozen). */
  preview: concreteStrengthReportSnapshotSchema,
  /** Why it can't be submitted now (state aside), or null. */
  submitBlocker: z.enum(CONCRETE_STRENGTH_SUBMIT_BLOCKERS).nullable(),
  /** Complete results not yet on an issued version (lab follow-up). */
  newResults: z.boolean(),
  latestVersion: concreteReportVersionSummarySchema.nullable(),
  latestIssuedVersionNo: z.number().nullable(),
  /** People who never review or issue the latest version (sole tester / entrant). */
  selfReviewUserIds: z.array(z.string()),
  allowedActions: z.array(z.enum(CONCRETE_REPORT_ACTIONS)),
});
export type ConcreteStrengthReportDetail = z.infer<typeof concreteStrengthReportDetailSchema>;

export const concreteStrengthReportListQuerySchema = z.strictObject({
  projectId: idSchema.optional(),
  /** Lab workspace: only sets where the lab has something to do (submit, correct, next age). */
  needsLab: z
    .enum(['true', 'false'], { error: 'Use true or false' })
    .transform((value) => value === 'true')
    .default(false),
  state: z.enum(CONCRETE_STRENGTH_REPORT_STATES, { error: 'Choose a status' }).optional(),
});
export type ConcreteStrengthReportListQuery = z.output<
  typeof concreteStrengthReportListQuerySchema
>;

/** Rows per list response; the list says when there are more. */
export const CONCRETE_STRENGTH_REPORT_LIST_MAX = 200;

export const concreteStrengthReportListItemSchema = z.object({
  setId: z.string(),
  reportId: z.string().nullable(),
  reportNumber: z.string().nullable(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  identity: concreteSpecimenIdentitySchema,
  castingDate: z.string().nullable(),
  state: z.enum(CONCRETE_STRENGTH_REPORT_STATES),
  latestVersionNo: z.number().nullable(),
  /** "Rev n" of the latest issue, null before the first issue. */
  issuedRevNo: z.number().nullable(),
  agesReported: z.array(z.number()),
  /** Complete results not yet on an issued or open version. */
  newResults: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type ConcreteStrengthReportListItem = z.infer<typeof concreteStrengthReportListItemSchema>;

export const concreteStrengthReportListSchema = z.object({
  items: z.array(concreteStrengthReportListItemSchema),
  truncated: z.boolean(),
});
export type ConcreteStrengthReportList = z.infer<typeof concreteStrengthReportListSchema>;
