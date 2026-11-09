import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C07: concrete test-result drafts, tester attribution and correction history
// (migration 0027).
//
// - A result attempt has a stable ID the client chooses (offline-safe): saving the same ID again
//   updates that attempt, never a second one.
// - Drafts only. Completed-test semantics, strength, rounding, pass/fail, end preparation and
//   fracture type are gated on the verified worksheet and methods (owner inputs G2/G8; C23). The
//   API never reports a strength or a completed test.
// - Units are stored with each result: kN for load and mm for dimensions, both provisional until
//   the worksheet is verified. The number of dimension readings isn't fixed (0 to 10 each).
// - Filling an empty field is entry; changing or clearing a saved value is a correction and
//   needs a reason. Missing data is empty, never zero.
// - The tester and the actual test date are values on the result: a later page default never
//   changes them. On the shared LAB account the request names the staff member entering it
//   (attribution only; LAB never gains their roles).

/** The fields a save may set. */
export const CONCRETE_TEST_RESULT_FIELDS = [
  'testedOn',
  'tester',
  'maxLoad',
  'heightReadings',
  'diameterReadings',
  'notes',
] as const;
export type ConcreteTestResultField = (typeof CONCRETE_TEST_RESULT_FIELDS)[number];

export const CONCRETE_TEST_RESULT_LOAD_UNITS = ['kN'] as const;
export const CONCRETE_TEST_RESULT_DIMENSION_UNITS = ['mm'] as const;
export const CONCRETE_TEST_RESULT_MAX_READINGS = 10;
export const CONCRETE_TEST_RESULT_STATES = ['draft'] as const;
export const CONCRETE_TEST_RESULT_REVISION_KINDS = ['initial', 'entry', 'correction'] as const;
export type ConcreteTestResultRevisionKind = (typeof CONCRETE_TEST_RESULT_REVISION_KINDS)[number];

const reading = (label: string, max: number) =>
  z
    .number({ error: `Enter the ${label} as a number` })
    .refine(Number.isFinite, { error: `Enter the ${label} as a number` })
    .gt(0, { error: `The ${label} must be more than 0` })
    .lt(max, { error: `The ${label} must be less than ${max}` });

/**
 * `PUT /api/concrete/specimens/:specimenId/test-results/:resultId` (`concrete_test.enter`: Lab
 * Technicians, Lab Managers and LAB naming the staff member). `version` 0 creates the attempt;
 * otherwise it is the result version the edit started from. An omitted field is unchanged; `null`
 * (or `[]` for readings) clears it, which is a correction when it held a value.
 */
export const concreteTestResultSaveRequestSchema = z.strictObject({
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
  version: z.number({ error: 'Version is required' }).int().min(0),
  /** LAB only: the staff member entering this (required on LAB). */
  enteredByUserId: z.uuid({ error: 'must be an ID' }).optional(),
  /** Who tested it. On a new attempt it defaults to the person entering it. */
  testerUserId: z.uuid({ error: 'must be an ID' }).nullable().optional(),
  testedOn: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).nullable().optional(),
  /** Machine maximum load (kN, provisional). */
  maxLoad: reading('maximum load', 100000).nullable().optional(),
  /** Height readings (mm, provisional). */
  heightReadings: z
    .array(reading('height', 10000))
    .max(CONCRETE_TEST_RESULT_MAX_READINGS, { error: 'Enter at most 10 readings' })
    .optional(),
  /** Diameter readings (mm, provisional). */
  diameterReadings: z
    .array(reading('diameter', 10000))
    .max(CONCRETE_TEST_RESULT_MAX_READINGS, { error: 'Enter at most 10 readings' })
    .optional(),
  notes: z
    .string()
    .trim()
    .max(2000, { error: 'Keep notes under 2000 characters' })
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  /** Required when the save changes or clears an already-saved value. */
  reason: z
    .string()
    .trim()
    .max(2000, { error: 'Keep the reason under 2000 characters' })
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});
export type ConcreteTestResultSaveRequest = z.input<typeof concreteTestResultSaveRequestSchema>;
export type ConcreteTestResultSaveInput = z.output<typeof concreteTestResultSaveRequestSchema>;

/** A field's stored value in comparable form (the tester by user ID). */
export type ConcreteTestResultValues = {
  testedOn: string | null;
  tester: string | null;
  maxLoad: number | null;
  heightReadings: number[];
  diameterReadings: number[];
  notes: string | null;
};

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (Array.isArray(value) && value.length === 0);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * How a save would change `saved` (null for a new attempt): which fields change, and which of
 * them are corrections (a saved value changed or cleared) and so need a reason. Shared so the
 * testing table asks for a reason exactly when the API will.
 */
export function concreteTestResultChanges(
  saved: ConcreteTestResultValues | null,
  proposed: Partial<ConcreteTestResultValues>,
): { changed: ConcreteTestResultField[]; corrections: ConcreteTestResultField[] } {
  const changed: ConcreteTestResultField[] = [];
  const corrections: ConcreteTestResultField[] = [];
  for (const field of CONCRETE_TEST_RESULT_FIELDS) {
    if (!(field in proposed) || proposed[field] === undefined) continue;
    const before = saved?.[field] ?? null;
    const after = proposed[field];
    if (same(isEmpty(before) ? null : before, isEmpty(after) ? null : after)) continue;
    changed.push(field);
    if (saved !== null && !isEmpty(before)) corrections.push(field);
  }
  return { changed, corrections };
}

export const concreteTestResultRevisionSchema = z.object({
  revisionNo: z.number().int(),
  kind: z.enum(CONCRETE_TEST_RESULT_REVISION_KINDS),
  /** Every field the save changed, with its value before and after. */
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })),
  reason: z.string().nullable(),
  /** The staff member credited with the entry (never LAB). */
  enteredBy: personSnapshotSchema,
  /** The signed-in account (LAB when a station saved it). */
  account: z.object({
    userId: z.string(),
    accountType: z.enum(['personal', 'shared_lab', 'test']),
  }),
  at: z.string(),
});
export type ConcreteTestResultRevision = z.infer<typeof concreteTestResultRevisionSchema>;

export const concreteTestResultSchema = z.object({
  id: z.string(),
  specimenId: z.string(),
  projectId: z.string(),
  attemptNo: z.number().int(),
  /** Always 'draft' until completed-test semantics are verified (C23). */
  state: z.enum(CONCRETE_TEST_RESULT_STATES),
  testedOn: z.string().nullable(),
  tester: personSnapshotSchema.nullable(),
  maxLoad: z.number().nullable(),
  heightReadings: z.array(z.number()),
  diameterReadings: z.array(z.number()),
  units: z.object({
    load: z.enum(CONCRETE_TEST_RESULT_LOAD_UNITS),
    dimension: z.enum(CONCRETE_TEST_RESULT_DIMENSION_UNITS),
    /** True until the worksheet's units are verified: never present these as validated. */
    provisional: z.boolean(),
  }),
  notes: z.string().nullable(),
  /** The registered testing machine when the attempt was created (none registered: null). */
  testingMachineId: z.string().nullable(),
  /** Prepared, always null until a verified method exists (no strength is ever calculated). */
  calculationMethod: z.string().nullable(),
  calculationMethodVersion: z.string().nullable(),
  reportVersionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
  revisions: z.array(concreteTestResultRevisionSchema),
});
export type ConcreteTestResult = z.infer<typeof concreteTestResultSchema>;

export const concreteTestResultSaveResultSchema = z.object({
  created: z.boolean(),
  result: concreteTestResultSchema,
});
export type ConcreteTestResultSaveResult = z.infer<typeof concreteTestResultSaveResultSchema>;

/** `GET /api/concrete/specimens/:specimenId/test-results` (`inventory.read`). */
export const concreteSpecimenTestResultsSchema = z.object({
  specimenId: z.string(),
  identity: concreteSpecimenIdentitySchema,
  results: z.array(concreteTestResultSchema),
});
export type ConcreteSpecimenTestResults = z.infer<typeof concreteSpecimenTestResultsSchema>;
