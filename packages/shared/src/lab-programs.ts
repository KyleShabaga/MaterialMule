import { z } from 'zod';
import type { FieldError } from './receipts';
import { stageKeySchema, type StageKey } from './stage';
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

/** How a frozen coverage row matched its line (program_scope_snapshot.matching_basis). */
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
  // MM-T26: resolved for closure, never acceptance.
  'cancelled',
] as const;
export type TestRequestStatus = (typeof TEST_REQUEST_STATUSES)[number];

export const TEST_REQUEST_STATUS_LABEL: Record<TestRequestStatus, string> = {
  requested: 'Requested',
  in_progress: 'In progress',
  completed: 'Completed',
  // The review sub-state (Awaiting review, Returned to Lab Manager, …) is shown beside it (MM-T25).
  review: 'In review',
  accepted: 'Accepted',
  cancelled: 'Cancelled',
};

/** A request's own Specific sample/depth after an accepted-request change (MM-T26). */
export const requestIdentitySchema = z.object({
  sampleLabel: z.string(),
  depthMode: z.enum(DEPTH_MODES),
  depthFrom: z.number(),
  depthTo: z.number().nullable(),
  depthUnit: z.enum(['ft', 'm']),
});
export type RequestIdentity = z.infer<typeof requestIdentitySchema>;

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
  /** MM-T26: the original this repeats, the amendment that added it, and its own identity. */
  repeatOfId: z.string().nullable().default(null),
  amendmentId: z.string().nullable().default(null),
  identityRevision: z.number().int().default(0),
  identity: requestIdentitySchema.nullable().default(null),
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
  /** The amendment that added it to a submitted program (MM-T26); null if frozen at submission. */
  amendmentId: z.string().nullable().default(null),
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
  /** The amendment that added this line after submission (MM-T26). */
  amendmentId: z.string().nullable().default(null),
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
  /**
   * Field Ledger list progress (one counted cell per test, progress only): done = Completed, In
   * review or Accepted; inProgress = In progress; notStarted = Requested (every test of a
   * draft); cancelled tests are counted apart and get no cell.
   */
  progress: z.object({
    done: z.number().int(),
    inProgress: z.number().int(),
    notStarted: z.number().int(),
    cancelled: z.number().int(),
  }),
  /** STRATA-58: the row's stage (optional until the API sends it on every row). */
  stage: stageKeySchema.optional(),
  /** STRATA-87: where the program is in its work (labProgramPhase); its tag is the status. */
  phase: z.enum(['draft', 'review', 'pull', 'testing', 'ready', 'closed']).optional(),
  /** When it was closed (Closed tab); null while open. */
  closedAt: z.string().nullable().optional(),
});
export type LabProgramSummary = z.infer<typeof labProgramSummarySchema>;

// ---------------------------------------------------------------------------------------------
// STRATA-87: a program's phase and its status tag ("<Stage> · <domain>", DESIGN.md › Soils lab).

/**
 * Where a program is in its work, derived on the server from its tests (never from wording):
 * - `draft`: not submitted;
 * - `pull` / `testing`: lab work is open (a test Requested, In progress or Completed but not yet
 *   sent to review), with covered units still to pull to the lab, or none;
 * - `review`: no lab work left, some test In review (review and acceptance);
 * - `ready`: every test accepted or cancelled with a reason, so it can close (who may close it
 *   is the lifecycle's `canClose`);
 * - `closed`.
 */
export const LAB_PROGRAM_PHASES = [
  'draft',
  'review',
  'pull',
  'testing',
  'ready',
  'closed',
] as const;
export type LabProgramPhase = (typeof LAB_PROGRAM_PHASES)[number];

/** The status tag per phase: its stage colour and its words. */
export const LAB_PROGRAM_PHASE_TAG: Record<LabProgramPhase, { stage: StageKey; label: string }> = {
  draft: { stage: 'draft', label: 'Draft · Lab program' },
  review: { stage: 'due', label: 'Due · Review' },
  pull: { stage: 'lab', label: 'In lab · Pull units' },
  testing: { stage: 'lab', label: 'In lab · Testing' },
  ready: { stage: 'due', label: 'Due · Ready to close' },
  closed: { stage: 'closed', label: 'Closed · Lab program' },
};

export interface LabProgramPhaseFacts {
  status: LabProgramStatus;
  /** Tests per status (a draft's are ignored). */
  counts: Partial<Record<TestRequestStatus, number>>;
  /** Some cancelled test has no reason (blocks closure, MM-T26). */
  cancelledWithoutReason?: boolean;
  /** A covered unit of a line with lab work open is in stock away from the lab. */
  unitsToPull: boolean;
}

/** The one rule for a program's phase (the list, the Workboard and the program page agree). */
export function labProgramPhase(facts: LabProgramPhaseFacts): LabProgramPhase {
  if (facts.status === 'draft') return 'draft';
  if (facts.status === 'closed') return 'closed';
  const n = (status: TestRequestStatus) => facts.counts[status] ?? 0;
  const open = n('requested') + n('in_progress') + n('completed');
  if (open > 0) return facts.unitsToPull ? 'pull' : 'testing';
  if (n('review') > 0) return 'review';
  const total = TEST_REQUEST_STATUSES.reduce((sum, status) => sum + n(status), 0);
  // An empty program never closes (MM-T26); it reads as lab work still to do.
  if (total === 0 || facts.cancelledWithoutReason) return 'testing';
  return 'ready';
}

/** Program counts per list tab (`GET /api/lab-programs` `counts`). */
export const labProgramTabCountsSchema = z.object({
  open: z.number().int(),
  /** This account's own drafts only. */
  drafts: z.number().int(),
  closed: z.number().int(),
});
export type LabProgramTabCounts = z.infer<typeof labProgramTabCountsSchema>;

/**
 * `GET /api/lab-programs/:id/units` (STRATA-87 "Units to pull"): the storage units in the
 * program's included frozen coverage, where each is now and whether the lab still has to pull it
 * (in stock away from a lab location while a covered line has a test Requested or In progress, the
 * same rule as the Workboard's pull list). Coverage is potential material only: never a record of
 * what was tested.
 */
export const programUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  contents: z.string().nullable(),
  /** Line numbers whose coverage includes it. */
  lineNumbers: z.array(z.number().int()),
  /** Where it is now; null when it is no longer in stock (disposed or removed). */
  location: z
    .object({ code: z.string(), name: z.string(), area: z.string().nullable() })
    .nullable(),
  atLab: z.boolean(),
  toPull: z.boolean(),
});
export type ProgramUnit = z.infer<typeof programUnitSchema>;

export const programUnitsSchema = z.object({
  units: z.array(programUnitSchema),
  toPull: z.number().int(),
  atLab: z.number().int(),
});
export type ProgramUnits = z.infer<typeof programUnitsSchema>;
/** Programs per page of GET /api/lab-programs (`?page=`, from 1). */
export const LAB_PROGRAM_PAGE_SIZE = 50;
/** Longest `?search=` the list uses (program number, project number or project name). */
export const LAB_PROGRAM_SEARCH_MAX = 100;
/** Largest `?pageSize=` the list accepts. */
export const LAB_PROGRAM_PAGE_SIZE_MAX = 100;
/**
 * STRATA-47 list sorts. `recent` (the default) keeps this account's drafts first, then the newest
 * submission or edit; `number` and `project` read A–Z by default, `submitted` newest first. The
 * program's ID always ends the order so pages never overlap or skip rows with equal keys.
 */
export const LAB_PROGRAM_LIST_SORTS = ['recent', 'number', 'project', 'submitted'] as const;
export type LabProgramListSort = (typeof LAB_PROGRAM_LIST_SORTS)[number];

const blankQueryParam = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * `GET /api/lab-programs?status=&projectId=&search=&sort=&dir=&page=&pageSize=`. Search
 * (program number, project number or project name; contains, ignoring case) and paging cover
 * every visible program; `total` counts all matches whatever the page size.
 */
export const labProgramListQuerySchema = z.object({
  status: z.preprocess(
    blankQueryParam,
    z.enum(LAB_PROGRAM_STATUSES, { error: 'must be draft, submitted or closed' }).optional(),
  ),
  projectId: z.preprocess(blankQueryParam, z.uuid({ error: 'must be a project ID' }).optional()),
  /** Longer input is cut to LAB_PROGRAM_SEARCH_MAX (the top-bar search sends what was typed). */
  search: z.preprocess(
    blankQueryParam,
    z
      .string()
      .trim()
      .transform((value) => value.slice(0, LAB_PROGRAM_SEARCH_MAX))
      .optional(),
  ),
  sort: z.preprocess(
    blankQueryParam,
    z
      .enum(LAB_PROGRAM_LIST_SORTS, { error: 'must be recent, number, project or submitted' })
      .default('recent'),
  ),
  dir: z.preprocess(
    blankQueryParam,
    z.enum(['asc', 'desc'], { error: 'must be asc or desc' }).optional(),
  ),
  page: z.preprocess(
    blankQueryParam,
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
  pageSize: z.preprocess(
    blankQueryParam,
    z.coerce
      .number({ error: 'must be a number' })
      .int()
      .min(1)
      .max(LAB_PROGRAM_PAGE_SIZE_MAX, { error: `must be at most ${LAB_PROGRAM_PAGE_SIZE_MAX}` })
      .default(LAB_PROGRAM_PAGE_SIZE),
  ),
});
export type LabProgramListQuery = z.output<typeof labProgramListQuerySchema>;

export function labProgramListSortDirection(query: Pick<LabProgramListQuery, 'sort' | 'dir'>) {
  return query.dir ?? (query.sort === 'number' || query.sort === 'project' ? 'asc' : 'desc');
}

export const labProgramListSchema = z.object({
  items: z.array(labProgramSummarySchema),
  total: z.number().int(),
  /** STRATA-87: counts per tab (Open, Drafts (mine), Closed), whatever the filters. */
  counts: labProgramTabCountsSchema.optional(),
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
