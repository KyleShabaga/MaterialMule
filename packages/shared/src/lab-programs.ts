import { z } from 'zod';
import type { FieldError } from './receipts';
import { formatPerson } from './staff';

// Testing programs, testing lines and test requests (MM-T23).
//
// A program belongs to one project. Each testing line names one project-scoped sampling source,
// chosen explicitly (never matched by free text):
//   * test_hole: a test hole of the project;
//   * standalone_unit: a Shelby tube whose own source is a standalone sampling location;
//   * standalone_bulk_group: a bulk-sample group whose source is a standalone location.
// The scope is ALL, All grabs (G), All SPT (S) or a Specific sample (full label plus depth).
// ALL / Grabs / SPT coverage is frozen when the program is submitted; it is potential material,
// never proof that a particular unit was tested.

export const LAB_PROGRAM_STATUSES = ['draft', 'submitted', 'closed'] as const;
export type LabProgramStatus = (typeof LAB_PROGRAM_STATUSES)[number];

export const PROGRAM_PRIORITIES = ['normal', 'urgent'] as const;
export type ProgramPriority = (typeof PROGRAM_PRIORITIES)[number];

export const LINE_SCOPES = ['all', 'grabs', 'spt', 'specific'] as const;
export type LineScope = (typeof LINE_SCOPES)[number];

export const LINE_SCOPE_LABEL: Record<LineScope, string> = {
  all: 'ALL',
  grabs: 'All grabs (G)',
  spt: 'All SPT (S)',
  specific: 'Specific sample',
};

export const LAB_SOURCE_KINDS = ['test_hole', 'standalone_unit', 'standalone_bulk_group'] as const;
export type LabSourceKind = (typeof LAB_SOURCE_KINDS)[number];

export const DEPTH_MODES = ['point', 'interval'] as const;
export type DepthMode = (typeof DEPTH_MODES)[number];

export const SAMPLE_LABEL_MAX_LENGTH = 40;
export const PROGRAM_NOTES_MAX_LENGTH = 2000;
export const MAX_LINES_PER_PROGRAM = 200;

/** How a frozen coverage row matched its line (migration 0030). */
export const MATCHING_BASES = [
  'hole_summary',
  'tube_source',
  'bulk_group_source',
  'standalone_unit',
  'bulk_group_member',
  'reviewed_included',
  'unknown_classification_excluded',
  'explicit_selection',
] as const;
export type MatchingBasis = (typeof MATCHING_BASES)[number];

export const MATCHING_BASIS_LABEL: Record<MatchingBasis, string> = {
  hole_summary: 'Test-hole summary',
  tube_source: 'Shelby tube from this hole',
  bulk_group_source: 'Bulk sample from this hole',
  standalone_unit: 'Selected standalone tube',
  bulk_group_member: 'Bucket of the selected bulk sample',
  reviewed_included: 'G/S unknown — included after review',
  unknown_classification_excluded: 'G/S unknown — excluded after review',
  explicit_selection: 'Linked to this sample',
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_DEPTH = 999_999.99;
const idSchema = z.uuid({ error: 'must be an ID' });

const uniqueIds = (label: string, max: number) =>
  z
    .array(idSchema, { error: `must be a list of ${label} IDs` })
    .max(max, { error: `can hold at most ${max}` })
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: 'custom',
          message: `lists a ${label} more than once`,
          params: { code: 'duplicate' },
        });
      }
    });

const depthValue = z
  .number({ error: 'must be a number' })
  .min(0, { error: 'must be 0 or more' })
  .max(MAX_DEPTH, { error: `must be at most ${MAX_DEPTH}` })
  .refine((value) => Math.round(value * 100) / 100 === value, {
    error: 'must have at most two decimal places',
  })
  .nullish()
  .transform((value) => value ?? null);

export const labSourceRefSchema = z.strictObject({
  kind: z.enum(LAB_SOURCE_KINDS, { error: 'must be a sampling source kind' }),
  id: idSchema,
});
export type LabSourceRef = z.infer<typeof labSourceRefSchema>;

/**
 * A draft line as the client saves it. Drafts may be incomplete (no source or tests yet); what a
 * submission needs is checked by `lineSubmitProblems` and again on the server.
 */
export const draftLineInputSchema = z
  .strictObject({
    /** Existing line to update; omitted for a new line. */
    id: idSchema.optional(),
    source: labSourceRefSchema.nullish().transform((value) => value ?? null),
    scope: z.enum(LINE_SCOPES, { error: 'must be all, grabs, spt or specific' }),
    sampleLabel: z
      .string({ error: 'must be text' })
      .trim()
      .max(SAMPLE_LABEL_MAX_LENGTH, {
        error: `must be at most ${SAMPLE_LABEL_MAX_LENGTH} characters`,
      })
      .refine((value) => !CONTROL_CHARACTERS.test(value), {
        error: "can't contain control characters",
      })
      .nullish()
      .transform((value) => (value ? value : null)),
    depthMode: z
      .enum(DEPTH_MODES, { error: 'must be point or interval' })
      .nullish()
      .transform((value) => value ?? null),
    depthFrom: depthValue,
    depthTo: depthValue,
    depthUnit: z
      .enum(['ft', 'm'], { error: 'must be ft or m' })
      .nullish()
      .transform((value) => value ?? null),
    testTypeIds: uniqueIds('test', 100).default([]),
    /** Explicitly chosen units (Grabs/SPT unknowns included after review; Specific links). */
    unitIds: uniqueIds('storage unit', 200).default([]),
    /** Depth variants of this sample identity the requester acknowledged, e.g. ["7.5 ft"]. */
    acknowledgedDepths: z.array(z.string().max(60)).max(50).default([]),
  })
  .superRefine((line, ctx) => {
    const issue = (path: string, message: string, code: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message, params: { code } });
    if (line.scope !== 'specific') {
      if (line.sampleLabel !== null)
        issue('sampleLabel', 'is only for a specific sample', 'not_allowed');
      if (line.depthMode !== null || line.depthFrom !== null || line.depthTo !== null) {
        issue('depthFrom', 'is only for a specific sample', 'not_allowed');
      }
      if (line.depthUnit !== null)
        issue('depthUnit', 'is only for a specific sample', 'not_allowed');
      if (line.scope === 'all' && line.unitIds.length > 0) {
        issue('unitIds', 'ALL covers every unit of the source; nothing to choose', 'not_allowed');
      }
    }
    if (line.depthMode === 'point' && line.depthTo !== null) {
      issue('depthTo', 'is only for an interval', 'not_allowed');
    }
    if (line.depthFrom !== null && line.depthTo !== null && line.depthTo < line.depthFrom) {
      issue('depthTo', 'must be greater than or equal to depth from', 'depth_range_reversed');
    }
  });
export type DraftLineInput = z.output<typeof draftLineInputSchema>;
export type DraftLineInputValue = z.input<typeof draftLineInputSchema>;

const notesSchema = z
  .string({ error: 'must be text' })
  .trim()
  .max(PROGRAM_NOTES_MAX_LENGTH, {
    error: `must be at most ${PROGRAM_NOTES_MAX_LENGTH} characters`,
  })
  .nullish()
  .transform((value) => (value ? value : null));

const linesSchema = z
  .array(draftLineInputSchema)
  .max(MAX_LINES_PER_PROGRAM, { error: `can hold at most ${MAX_LINES_PER_PROGRAM} lines` });

/**
 * `POST /api/lab-programs`. A shared LAB station must name who the program is requested by
 * (attribution only; it grants nothing). A personal account is its own requester.
 */
export const createLabProgramRequestSchema = z.strictObject({
  projectId: idSchema,
  idempotencyKey: idSchema,
  requestedByUserId: idSchema.optional(),
  notes: notesSchema,
  lines: linesSchema.default([]),
});
export type CreateLabProgramRequest = z.output<typeof createLabProgramRequestSchema>;
export type CreateLabProgramRequestInput = z.input<typeof createLabProgramRequestSchema>;

/** `PATCH /api/lab-programs/:id` (draft only). `lines` replaces the draft's lines when given. */
export const updateLabProgramRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  requestedByUserId: idSchema.optional(),
  notes: notesSchema.optional(),
  lines: linesSchema.optional(),
});
export type UpdateLabProgramRequest = z.output<typeof updateLabProgramRequestSchema>;
export type UpdateLabProgramRequestInput = z.input<typeof updateLabProgramRequestSchema>;

/**
 * `POST /api/lab-programs/:id/submit`. `coverage` repeats, for every ALL / Grabs / SPT line, the
 * candidate units the review showed: if the material changed since, the server refuses (409
 * `coverage_changed`) instead of freezing something nobody reviewed.
 */
export const submitLabProgramRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  idempotencyKey: idSchema,
  requestedByUserId: idSchema.optional(),
  coverage: z
    .array(z.strictObject({ lineId: idSchema, unitIds: uniqueIds('storage unit', 500) }))
    .max(MAX_LINES_PER_PROGRAM)
    .default([]),
});
export type SubmitLabProgramRequest = z.output<typeof submitLabProgramRequestSchema>;
export type SubmitLabProgramRequestInput = z.input<typeof submitLabProgramRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const labSourceSchema = z.object({
  kind: z.enum(LAB_SOURCE_KINDS),
  id: z.string(),
  /** "TH26-01", "Embankment Location 03 · ST-2026-000004", "Embankment … · B1 at 1.5 m". */
  label: z.string(),
  /** Units currently eligible from this source. */
  unitCount: z.number().int(),
});
export type LabSource = z.infer<typeof labSourceSchema>;
export const labSourceListSchema = z.array(labSourceSchema);

export const personSnapshotSchema = z.object({
  userId: z.string(),
  initials: z.string().nullable(),
  name: z.string(),
});
export type PersonSnapshot = z.infer<typeof personSnapshotSchema>;

export const accountSnapshotSchema = personSnapshotSchema.extend({
  accountType: z.enum(['personal', 'shared_lab', 'test']),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

export const lineTestSchema = z.object({
  testTypeId: z.string(),
  code: z.string(),
  displayName: z.string(),
  description: z.string(),
  groupName: z.string(),
  subgroupName: z.string().nullable(),
  active: z.boolean(),
});
export type LineTest = z.infer<typeof lineTestSchema>;

export const TEST_REQUEST_STATUSES = [
  'requested',
  'in_progress',
  'completed',
  'review',
  'accepted',
] as const;
export type TestRequestStatus = (typeof TEST_REQUEST_STATUSES)[number];

export const TEST_REQUEST_STATUS_LABEL: Record<TestRequestStatus, string> = {
  requested: 'Requested',
  in_progress: 'In progress',
  completed: 'Completed',
  // The review sub-state (Awaiting review, Returned to Lab Manager, …) is shown beside it (MM-T25).
  review: 'In review',
  accepted: 'Accepted',
};

export const testRequestSchema = z.object({
  id: z.string(),
  testTypeId: z.string(),
  code: z.string(),
  name: z.string().nullable(),
  description: z.string(),
  groupName: z.string(),
  subgroupName: z.string().nullable(),
  status: z.enum(TEST_REQUEST_STATUSES),
  version: z.number().int(),
});
export type TestRequest = z.infer<typeof testRequestSchema>;

export const coverageUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  unitType: z.string(),
  contents: z.string().nullable(),
  receivedDate: z.string(),
  receiptId: z.string(),
  included: z.boolean(),
  matchingBasis: z.enum(MATCHING_BASES),
});
export type CoverageUnit = z.infer<typeof coverageUnitSchema>;

export const labLineSchema = z.object({
  id: z.string(),
  lineNumber: z.number().int(),
  source: labSourceSchema.omit({ unitCount: true }).nullable(),
  scope: z.enum(LINE_SCOPES),
  sampleLabel: z.string().nullable(),
  depthMode: z.enum(DEPTH_MODES).nullable(),
  depthFrom: z.number().nullable(),
  depthTo: z.number().nullable(),
  depthUnit: z.enum(['ft', 'm']).nullable(),
  acknowledgedDepths: z.array(z.string()),
  /** Draft: tests picked, with current catalogue values. */
  tests: z.array(lineTestSchema),
  /** Draft: explicitly chosen units. */
  unitIds: z.array(z.string()),
  /** Submitted: requested tests with their frozen catalogue snapshots. */
  requests: z.array(testRequestSchema),
  /** Submitted: frozen coverage (included and reviewed-excluded units). */
  coverage: z.array(coverageUnitSchema),
  coverageCapturedAt: z.string().nullable(),
});
export type LabLine = z.infer<typeof labLineSchema>;

export const labProgramSchema = z.object({
  id: z.string(),
  programNumber: z.string().nullable(),
  status: z.enum(LAB_PROGRAM_STATUSES),
  priority: z.enum(PROGRAM_PRIORITIES),
  notes: z.string().nullable(),
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  createdBy: accountSnapshotSchema,
  requestedBy: personSnapshotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
  submittedAt: z.string().nullable(),
  submittedBy: accountSnapshotSchema.nullable(),
  submittedFor: personSnapshotSchema.nullable(),
  lines: z.array(labLineSchema),
});
export type LabProgram = z.infer<typeof labProgramSchema>;

export const labProgramSummarySchema = z.object({
  id: z.string(),
  programNumber: z.string().nullable(),
  status: z.enum(LAB_PROGRAM_STATUSES),
  priority: z.enum(PROGRAM_PRIORITIES),
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  createdBy: accountSnapshotSchema,
  requestedBy: personSnapshotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  submittedAt: z.string().nullable(),
  lineCount: z.number().int(),
  testCount: z.number().int(),
});
export type LabProgramSummary = z.infer<typeof labProgramSummarySchema>;
export const labProgramListSchema = z.object({
  items: z.array(labProgramSummarySchema),
  total: z.number().int(),
});
export type LabProgramList = z.infer<typeof labProgramListSchema>;

export const depthDiscrepancySchema = z.object({
  /** Every depth seen for this identity (this line's included), e.g. ["7.5 ft", "8 ft"]. */
  depths: z.array(z.string()),
  /** Other requests for the same identity with a different depth. */
  others: z.array(
    z.object({
      programId: z.string(),
      programNumber: z.string().nullable(),
      lineNumber: z.number().int(),
      depth: z.string(),
    }),
  ),
  acknowledged: z.boolean(),
});
export type DepthDiscrepancy = z.infer<typeof depthDiscrepancySchema>;

export const lineReviewSchema = z.object({
  lineId: z.string(),
  lineNumber: z.number().int(),
  /** Candidate units with what submission would freeze: included or reviewed-excluded. */
  coverage: z.array(coverageUnitSchema),
  /** Grabs/SPT candidates with no structured G/S classification (all are, today). */
  unknownClassificationCount: z.number().int(),
  discrepancy: depthDiscrepancySchema.nullable(),
  retiredTests: z.array(lineTestSchema),
  problems: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
});
export type LineReview = z.infer<typeof lineReviewSchema>;

/** `GET /api/lab-programs/:id/review`: what submitting now would record. */
export const labProgramReviewSchema = z.object({
  programId: z.string(),
  version: z.number().int(),
  lines: z.array(lineReviewSchema),
  /** True when nothing blocks submission. */
  ready: z.boolean(),
});
export type LabProgramReview = z.infer<typeof labProgramReviewSchema>;

/** A unit a line could cover or link, for the Grabs/SPT review and the Specific unit picker. */
export const labSourceUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  unitType: z.string(),
  contents: z.string().nullable(),
  receivedDate: z.string(),
});
export type LabSourceUnit = z.infer<typeof labSourceUnitSchema>;
export const labSourceUnitListSchema = z.array(labSourceUnitSchema);

/** Error codes the program API returns in `{ code }` bodies. */
export type LabProgramErrorCode =
  | 'lab_program_not_found'
  | 'version_conflict'
  | 'not_draft'
  | 'requested_by_required'
  | 'requested_by_invalid'
  | 'requested_by_mismatch'
  | 'source_not_in_project'
  | 'unit_not_in_source'
  | 'test_type_not_found'
  | 'retired_tests'
  | 'coverage_changed'
  | 'not_ready'
  | 'idempotency_key_reused';

// ---------------------------------------------------------------------------------------------
// Rules shared by the browser and the server
// ---------------------------------------------------------------------------------------------

/** Trailing zeros dropped: 7.50 → "7.5". */
const num = (value: number) => String(Number(value.toFixed(2)));

/** "7.5 ft", "1.5–2 m", or null when incomplete. */
export function formatLineDepth(
  line: Pick<LabLine, 'depthMode' | 'depthFrom' | 'depthTo' | 'depthUnit'>,
): string | null {
  if (line.depthFrom === null || line.depthUnit === null || line.depthMode === null) return null;
  if (line.depthMode === 'interval') {
    if (line.depthTo === null) return null;
    return `${num(line.depthFrom)}–${num(line.depthTo)} ${line.depthUnit}`;
  }
  return `${num(line.depthFrom)} ${line.depthUnit}`;
}

/** Depth text compared for discrepancies (dashes folded, so typed variants still match). */
export function depthKey(depth: string): string {
  return depth
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Sample identity = project + source + full label, ignoring case: G3 ≠ S3, and G3 in TH26-01 ≠
 * G3 in TH26-02. Depth is recorded separately and never part of the identity.
 */
export function sampleIdentityKey(source: LabSourceRef, label: string): string {
  return `${source.kind}:${source.id}:${label.trim().toUpperCase()}`;
}

/** Problems that keep a line from being submitted (the server checks these again). */
export function lineSubmitProblems(
  line: Pick<
    DraftLineInput,
    'source' | 'scope' | 'sampleLabel' | 'depthMode' | 'depthFrom' | 'depthTo' | 'depthUnit'
  > & { testCount: number },
): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, code: string, message: string) =>
    problems.push({ field, code, message });
  if (line.source === null) add('source', 'required', 'Choose a sampling source.');
  if (line.testCount === 0) add('testTypeIds', 'required', 'Pick at least one test.');
  if (line.scope === 'specific') {
    if (line.sampleLabel === null)
      add('sampleLabel', 'required', 'Enter the sample label, e.g. G3.');
    if (line.depthMode === null)
      add('depthMode', 'required', 'Choose a single depth or an interval.');
    if (line.depthFrom === null) add('depthFrom', 'required', 'Enter the depth.');
    if (line.depthMode === 'interval' && line.depthTo === null) {
      add('depthTo', 'required', 'Enter where the interval ends.');
    }
    if (line.depthUnit === null) add('depthUnit', 'required', 'Choose ft or m.');
  }
  return problems;
}

/** "LAB for JS · Jordan Smith", or just the person for a personal account. */
export function formatAttribution(
  account: Pick<AccountSnapshot, 'accountType' | 'name'>,
  person: Pick<PersonSnapshot, 'initials' | 'name'> | null,
): string {
  if (account.accountType === 'shared_lab' && person) {
    return `${account.name} for ${formatPerson(person.initials, person.name)}`;
  }
  return person ? formatPerson(person.initials, person.name) : account.name;
}

export function programLabel(program: Pick<LabProgram, 'programNumber'>): string {
  return program.programNumber ?? 'Draft program';
}

/** `POST /api/lab-programs/:id/discard` (draft only). */
export const discardLabProgramRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  requestedByUserId: z.uuid({ error: 'must be an ID' }).optional(),
});
export type DiscardLabProgramRequest = z.output<typeof discardLabProgramRequestSchema>;
