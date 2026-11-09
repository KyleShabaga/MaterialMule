import { z } from 'zod';
import {
  concreteDraftCompletenessSchema,
  concreteIssuanceSchema,
  concreteWorkflowSchema,
  type ConcreteDraftCompleteness,
} from './concrete';
import { concreteEquipmentUseSchema } from './concrete-equipment';
import {
  CONCRETE_ADMIXTURES_NOT_ANSWERED,
  concreteAdmixturesSchema,
  concreteAggregateSizeMmSchema,
  concreteAirPercentSchema,
  concreteMixSnapshotSchema,
  concreteSlumpMmSchema,
  concreteSlumpToleranceMmSchema,
  concreteStrengthAgeDaysSchema,
  concreteStrengthMpaSchema,
  type ConcreteMixSnapshot,
} from './concrete-mixes';
import { concreteReportLifecycleSchema } from './concrete-report-lifecycle';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C04: concrete field-report detail and the draft APIs (migration 0019). Source: spec page 2
// "Field report and field map" (CD-13–CD-20, CD-58) and page 1's submission blockers / warnings.
//
// Two contracts, kept apart (card §2):
//   * the draft contract — what may be saved at any time. Every field is optional and nullable;
//     blank text becomes null; missing data is null, never 0, false or "No" (AC1).
//   * the final-review contract — what review submission will need, computed from a saved draft
//     each time (`concreteFieldReportReview`) and never stored. Submission itself is C19's.
//
// Three sources are kept apart: the report's project-spec and ticket columns (autofilled from the
// mix, then editable), the registry snapshot they came from (`concreteMixSnapshotSchema`, a copy
// that registry edits never rewrite) and the measured results. Field data never edits the mix
// registry (C03 AC4).
//
// Open, so deliberately not modelled: the paper sheet's Field ID vs Set ID meaning (CD-65,
// `paperFieldId` is uninterpreted text and never a set ID), the printed element list (labels are
// free text until the form maps them), SCC / flow tests, project-required unit weight and
// admixture dosage rules.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const idSchema = z.uuid({ error: 'must be an ID' });
const timestampSchema = z.iso.datetime({ offset: true, error: 'must be a date and time' });
const dateSchema = z.iso.date({ error: 'must be a date (YYYY-MM-DD)' });

/** Optional text: trimmed, blank → null (a blank field is missing, not a value). */
function text(name: string, max: number, multiline = false) {
  const control = multiline ? CONTROL_CHARACTERS_EXCEPT_NEWLINES : CONTROL_CHARACTERS;
  return z
    .string({ error: `${name} must be text` })
    .trim()
    .max(max, { error: `${name} must be ${max} characters or fewer` })
    .refine((value) => !control.test(value), {
      message: `${name} can't contain control characters`,
    })
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

/** A decimal with at most `places` places within [min, max]. */
function decimal(name: string, min: number, max: number, places: number, exclusiveMin = false) {
  const factor = 10 ** places;
  return z
    .number({ error: `${name} must be a number` })
    .refine((value) => Number.isFinite(value), { message: `${name} must be a number` })
    .refine((value) => (exclusiveMin ? value > min : value >= min), {
      message: exclusiveMin ? `${name} must be more than ${min}` : `${name} must be ${min} or more`,
    })
    .refine((value) => value <= max, { message: `${name} must be ${max} or less` })
    .refine((value) => Math.abs(Math.round(value * factor) - value * factor) < 1e-6, {
      message: `${name} allows ${places} decimal place${places === 1 ? '' : 's'}`,
    })
    .nullable();
}

// ---------------------------------------------------------------------------------------------
// Choices (spec page 2)
// ---------------------------------------------------------------------------------------------

export const CONCRETE_SAMPLING_LOCATIONS = ['chute', 'end_of_pump', 'hopper', 'other'] as const;
export type ConcreteSamplingLocation = (typeof CONCRETE_SAMPLING_LOCATIONS)[number];

export const CONCRETE_PLACEMENT_METHODS = [
  'chute',
  'pump',
  'extruder',
  'crane_bucket',
  'wheel_barrow',
  'other',
] as const;
export type ConcretePlacementMethod = (typeof CONCRETE_PLACEMENT_METHODS)[number];

/** Grouts take the G prefix on their permanent set ID (CD-11, allocated by C18). */
export const CONCRETE_MATERIALS = [
  'concrete',
  'epoxy_grout',
  'cementitious_grout',
  'cellular_concrete',
  'scc',
] as const;
export type ConcreteMaterial = (typeof CONCRETE_MATERIALS)[number];

export const CONCRETE_SUPERPLASTICIZER_ADDED = ['on_site', 'at_plant', 'none'] as const;
export type ConcreteSuperplasticizerAdded = (typeof CONCRETE_SUPERPLASTICIZER_ADDED)[number];

/** What the form preselects (C14). The server stores only what is sent, so these never default. */
export const CONCRETE_FIELD_FORM_PRESELECTED = {
  material: 'concrete',
  specimensCast: true,
} as const satisfies { material: ConcreteMaterial; specimensCast: boolean };

/**
 * The element label meaning "Other" (its text then goes in `locationElementOther`). The 32
 * printed choices aren't mapped yet, so elements are labels; the form (C14) owns the list.
 */
export const CONCRETE_LOCATION_ELEMENT_OTHER = 'Other';

export const CONCRETE_READING_TESTS = ['slump', 'air'] as const;
export type ConcreteReadingTest = (typeof CONCRETE_READING_TESTS)[number];

/** A reading's context never changes once saved (database rule); retests never overwrite. */
export const CONCRETE_READING_CONTEXTS = [
  'initial',
  'retest',
  'after_superplasticizer',
  'after_water',
] as const;
export type ConcreteReadingContext = (typeof CONCRETE_READING_CONTEXTS)[number];

export const CONCRETE_MAX_READINGS_PER_TEST = 50;
export const CONCRETE_ATTACHMENT_KINDS = ['ticket_photo', 'ticket_file'] as const;

// ---------------------------------------------------------------------------------------------
// Parts of the draft
// ---------------------------------------------------------------------------------------------

/**
 * One column of "Mix spec vs ticket" as on this report: the project specification or the
 * supplier ticket. Null members are blank. Autofilled from the mix, then editable.
 */
export const concreteReportSpecColumnSchema = z
  .strictObject({
    specifiedStrengthMpa: concreteStrengthMpaSchema.nullable().default(null),
    /** Optional on the sheet ("spec age optional"). */
    specifiedStrengthAgeDays: concreteStrengthAgeDaysSchema.nullable().default(null),
    slumpTargetMm: concreteSlumpMmSchema.nullable().default(null),
    slumpToleranceMm: concreteSlumpToleranceMmSchema.nullable().default(null),
    airMinPercent: concreteAirPercentSchema.nullable().default(null),
    airMaxPercent: concreteAirPercentSchema.nullable().default(null),
    maxAggregateSizeMm: concreteAggregateSizeMmSchema.nullable().default(null),
    cementType: text('Cement type', 100).default(null),
    admixtures: concreteAdmixturesSchema.default(CONCRETE_ADMIXTURES_NOT_ANSWERED),
  })
  .superRefine((value, ctx) => {
    if (
      value.airMinPercent !== null &&
      value.airMaxPercent !== null &&
      value.airMinPercent > value.airMaxPercent
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['airMaxPercent'],
        message: 'Air maximum must be at least the minimum',
      });
    }
  });
export type ConcreteReportSpecColumn = z.output<typeof concreteReportSpecColumnSchema>;
export const CONCRETE_REPORT_SPEC_EMPTY: ConcreteReportSpecColumn =
  concreteReportSpecColumnSchema.parse({});
export type ConcreteReportSpecField = Exclude<keyof ConcreteReportSpecColumn, 'admixtures'>;

/** The five rows the sheet requires in both columns (strength, slump, air, aggregate, cement). */
export const CONCRETE_REPORT_SPEC_REQUIRED = [
  'specifiedStrengthMpa',
  'slumpTargetMm',
  'slumpToleranceMm',
  'airMinPercent',
  'airMaxPercent',
  'maxAggregateSizeMm',
  'cementType',
] as const satisfies readonly ConcreteReportSpecField[];

/** A partial change to one spec column: given members replace, others stay. */
export const concreteReportSpecPatchSchema = z.strictObject({
  specifiedStrengthMpa: concreteStrengthMpaSchema.nullable().optional(),
  specifiedStrengthAgeDays: concreteStrengthAgeDaysSchema.nullable().optional(),
  slumpTargetMm: concreteSlumpMmSchema.nullable().optional(),
  slumpToleranceMm: concreteSlumpToleranceMmSchema.nullable().optional(),
  airMinPercent: concreteAirPercentSchema.nullable().optional(),
  airMaxPercent: concreteAirPercentSchema.nullable().optional(),
  maxAggregateSizeMm: concreteAggregateSizeMmSchema.nullable().optional(),
  cementType: text('Cement type', 100).optional(),
  admixtures: concreteAdmixturesSchema.optional(),
});
export type ConcreteReportSpecPatch = z.input<typeof concreteReportSpecPatchSchema>;

/**
 * One slump or air reading. `id` is client-generated (stable across offline saves and sync);
 * order within a test is the order sent. The initial reading's time is the report's test time;
 * every other reading carries its own `measuredAt`.
 */
export const concreteFieldReadingInputSchema = z
  .strictObject({
    id: idSchema,
    test: z.enum(CONCRETE_READING_TESTS, { error: 'Choose slump or air' }),
    context: z.enum(CONCRETE_READING_CONTEXTS, { error: 'Choose initial, retest or addition' }),
    /** Slump mm or air %; null = not measured yet. */
    value: decimal('Reading', 0, 99999.9, 1).default(null),
    measuredAt: timestampSchema.nullable().default(null),
    note: text('Note', 500).default(null),
  })
  .superRefine((reading, ctx) => {
    if (reading.test === 'air' && reading.value !== null && reading.value > 100) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Air must be 100 or less' });
    }
  });
export type ConcreteFieldReadingInput = z.input<typeof concreteFieldReadingInputSchema>;

export const concreteFieldReadingsSchema = z
  .array(concreteFieldReadingInputSchema)
  .max(CONCRETE_MAX_READINGS_PER_TEST * CONCRETE_READING_TESTS.length)
  .superRefine((readings, ctx) => {
    if (new Set(readings.map((r) => r.id)).size !== readings.length) {
      ctx.addIssue({ code: 'custom', message: 'Each reading once' });
    }
    for (const test of CONCRETE_READING_TESTS) {
      const ofTest = readings.filter((r) => r.test === test);
      if (ofTest.filter((r) => r.context === 'initial').length > 1) {
        ctx.addIssue({ code: 'custom', message: `One initial ${test} reading` });
      }
      if (ofTest.length > CONCRETE_MAX_READINGS_PER_TEST) {
        ctx.addIssue({
          code: 'custom',
          message: `At most ${CONCRETE_MAX_READINGS_PER_TEST} ${test} readings`,
        });
      }
    }
  });

/** Attachment metadata only (C15 owns the files, their upload and acknowledgment). */
export const concreteAttachmentRefSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(CONCRETE_ATTACHMENT_KINDS, { error: 'Choose ticket photo or ticket file' }),
  fileName: text('File name', 200).refine((v) => v !== null, { message: 'Enter the file name' }),
  capturedAt: timestampSchema.nullable().default(null),
});
export type ConcreteAttachmentRef = z.output<typeof concreteAttachmentRefSchema>;

const labelList = (name: string, max: number, itemMax: number) =>
  z
    .array(
      z
        .string({ error: `${name} must be text` })
        .trim()
        .min(1, { error: `${name} can't be blank` })
        .max(itemMax, { error: `${name} must be ${itemMax} characters or fewer` })
        .refine((value) => !CONTROL_CHARACTERS.test(value), {
          message: `${name} can't contain control characters`,
        }),
    )
    .max(max, { error: `Choose at most ${max}` })
    .refine((items) => new Set(items.map((i) => i.toLowerCase())).size === items.length, {
      message: 'Each once',
    });

/**
 * Every draft field, flat. In a request each is optional (absent: unchanged on save, null on
 * create); null or blank text clears it.
 */
const draftFields = {
  // Project info
  reportDate: dateSchema.nullable(),
  contractorName: text('Contractor', 200),
  /** CD-65 open: the paper sheet's reference as written; no meaning, never a set ID. */
  paperFieldId: text('Paper field ID', 50),
  // Test location
  locationElements: labelList('Element', 40, 100),
  locationElementOther: text('Other element', 200),
  locationDescription: text('Location', 500),
  // Delivery
  supplierName: text('Supplier', 200),
  mixNumber: text('Mix number', 100),
  ticketNumber: text('Ticket number', 100),
  truckNumber: text('Truck number', 100),
  plantName: text('Plant', 200),
  batchedAt: timestampSchema.nullable(),
  loadVolumeM3: decimal('Load volume', 0, 999999.99, 2),
  /** Manual (card §2). */
  cumulativeVolumeM3: decimal('Cumulative volume', 0, 99999999.99, 2),
  // Times
  arrivedAt: timestampSchema.nullable(),
  sampledAt: timestampSchema.nullable(),
  testedAt: timestampSchema.nullable(),
  castAt: timestampSchema.nullable(),
  timeLimitExceeded: z.boolean({ error: 'Answer yes or no' }).nullable(),
  timeLimitInformed: text('Who was informed', 200),
  // Load decision
  loadRejected: z.boolean({ error: 'Answer yes or no' }).nullable(),
  loadDecisionByName: text('Accepted or rejected by', 200),
  loadDecisionByCompany: text('Company', 200),
  // Sampling and placement
  samplingLocation: z
    .enum(CONCRETE_SAMPLING_LOCATIONS, { error: 'Choose a sampling location' })
    .nullable(),
  samplingLocationOther: text('Other sampling location', 200),
  placementMethods: z
    .array(z.enum(CONCRETE_PLACEMENT_METHODS, { error: 'Choose a placement method' }))
    .max(CONCRETE_PLACEMENT_METHODS.length)
    .refine((items) => new Set(items).size === items.length, { message: 'Each once' }),
  placementMethodOther: text('Other placement method', 200),
  // Material and fresh tests
  material: z.enum(CONCRETE_MATERIALS, { error: 'Choose a material' }).nullable(),
  superplasticizerAdded: z
    .enum(CONCRETE_SUPERPLASTICIZER_ADDED, { error: 'Choose on site, at plant or no SP' })
    .nullable(),
  unitWeightKgM3: decimal('Unit weight', 0, 999999.9, 1, true),
  concreteTempC: decimal('Concrete temperature', -60, 100, 1),
  ambientTempC: decimal('Ambient temperature', -60, 100, 1),
  waterAdded: z.boolean({ error: 'Answer yes or no' }).nullable(),
  waterAddedAuthorizedBy: text('Authorized by', 200),
  specimensCast: z.boolean({ error: 'Answer yes or no' }).nullable(),
  /** Optional (CD-45); evaluated against its calibration on the report date (C27). */
  airMeterEquipmentId: idSchema.nullable(),
  // Notes
  comments: text('Comments', 4000, true),
  resultsReportedToName: text('Results reported to', 200),
  resultsReportedToCompany: text('Company', 200),
};

export type ConcreteFieldReportDraftField = keyof typeof draftFields;
export const CONCRETE_FIELD_REPORT_DRAFT_FIELDS = Object.keys(
  draftFields,
) as ConcreteFieldReportDraftField[];

const optionalDraftFields = Object.fromEntries(
  Object.entries(draftFields).map(([key, schema]) => [key, schema.optional()]),
) as { [K in keyof typeof draftFields]: z.ZodOptional<(typeof draftFields)[K]> };

const draftChanges = {
  ...optionalDraftFields,
  /**
   * The registry mix (same project), or null for none / unknown (CD-15: then supplier and mix
   * number are typed and the report is flagged). Choosing one stores a snapshot of its revision.
   */
  mixId: idSchema.nullable().optional(),
  /**
   * Replace the spec columns (and blank supplier, mix number, a single plant) with the chosen
   * mix's values — the form asks first (spec: changing the mix asks before replacing). Explicit
   * values in the same request still win. Measured results and times never change.
   */
  applyMixDefaults: z.boolean().optional(),
  projectSpec: concreteReportSpecPatchSchema.optional(),
  ticketSpec: concreteReportSpecPatchSchema.optional(),
  /** The full list of readings when given: rows left out are removed (drafts only). */
  readings: concreteFieldReadingsSchema.optional(),
  /** The full list of attachment references when given. */
  attachmentRefs: z
    .array(concreteAttachmentRefSchema)
    .max(50)
    .refine((refs) => new Set(refs.map((r) => r.id)).size === refs.length, {
      message: 'Each attachment once',
    })
    .optional(),
};

/**
 * LAB names the performing staff member (`technicianUserId`, attribution only); a personal
 * account is always its own technician and may omit it.
 */
const attribution = {
  technicianUserId: idSchema.optional(),
};

export const createConcreteFieldReportRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  /** Client-generated report id (offline drafts, later imports); the server makes one if absent. */
  id: idSchema.optional(),
  ...attribution,
  ...draftChanges,
});
export type CreateConcreteFieldReportRequest = z.input<
  typeof createConcreteFieldReportRequestSchema
>;

export const saveConcreteFieldReportRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  /** The version the edit is based on; a stale one is 409 `version_conflict`, nothing written. */
  version: z.int().positive(),
  ...attribution,
  ...draftChanges,
});
export type SaveConcreteFieldReportRequest = z.input<typeof saveConcreteFieldReportRequestSchema>;

export const CONCRETE_FIELD_REPORT_PAGE_SIZE_MAX = 100;

export const concreteFieldReportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(CONCRETE_FIELD_REPORT_PAGE_SIZE_MAX).default(25),
  state: z
    .enum(['draft', 'ready_to_submit', 'submitted', 'returned', 'reviewed', 'void'])
    .optional(),
  technicianUserId: idSchema.optional(),
  /**
   * MM-V2-C30 (project Reports tab): contains, ignoring case, in the supplier, mix number, ticket,
   * paper Field ID, location, structure element or technician name.
   */
  search: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(200).optional(),
  ),
  /** MM-V2-C30: issued reports only (any workflow state), or never-issued ones. */
  issued: z.enum(['true', 'false']).optional(),
});
export type ConcreteFieldReportListQuery = z.output<typeof concreteFieldReportListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Saved draft (responses)
// ---------------------------------------------------------------------------------------------

export const concreteFieldReadingSchema = z.object({
  id: z.string(),
  test: z.enum(CONCRETE_READING_TESTS),
  context: z.enum(CONCRETE_READING_CONTEXTS),
  /** 1, 2, 3 … within the report and test, in the order sent. */
  position: z.number(),
  value: z.number().nullable(),
  measuredAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type ConcreteFieldReading = z.infer<typeof concreteFieldReadingSchema>;

const savedFields = Object.fromEntries(
  Object.entries(draftFields).map(([key, schema]) => [key, schema]),
) as typeof draftFields;

export const concreteFieldReportFieldsSchema = z.object({
  ...savedFields,
  mixId: z.string().nullable(),
  projectSpec: concreteReportSpecColumnSchema,
  ticketSpec: concreteReportSpecColumnSchema,
  readings: z.array(concreteFieldReadingSchema),
  attachmentRefs: z.array(concreteAttachmentRefSchema),
});
export type ConcreteFieldReportFields = z.output<typeof concreteFieldReportFieldsSchema>;

/** Review warnings (spec page 1: warnings never block; the reviewer resolves them). */
export const CONCRETE_FIELD_REPORT_WARNINGS = [
  'unknown_mix',
  'unapproved_mix',
  'slump_out_of_range',
  'air_out_of_range',
  'ticket_differs_from_spec',
  'duplicate_ticket',
  'air_meter_flag',
  // MM-V2-C05
  'specimens_recorded_but_not_cast',
] as const;
export type ConcreteFieldReportWarningCode = (typeof CONCRETE_FIELD_REPORT_WARNINGS)[number];

export const concreteFieldReportWarningSchema = z.object({
  code: z.enum(CONCRETE_FIELD_REPORT_WARNINGS),
  /** The field path it concerns, when one. */
  field: z.string().nullable(),
  message: z.string(),
});
export type ConcreteFieldReportWarning = z.infer<typeof concreteFieldReportWarningSchema>;

/**
 * Final-review checks this card can't make yet, each owned by a later card. Listed so a screen
 * never presents the computed list as the whole submission check.
 */
export const CONCRETE_FIELD_REPORT_DEFERRED_CHECKS = [
  { code: 'project_matched', owner: 'C17' },
  { code: 'ticket_attachment_acknowledged', owner: 'C15' },
  { code: 'pickup_and_curing_recorded', owner: 'C06' },
  { code: 'specimens_received_with_mass', owner: 'C06' },
  { code: 'specimen_identity_resolved', owner: 'C18' },
  { code: 'permanent_ids_confirmed', owner: 'C20' },
] as const;

export const concreteFieldReportReviewSchema = z.object({
  /** Required fields still missing; the same list as `completeness.missingRequired`. */
  missingRequired: z.array(z.string()),
  warnings: z.array(concreteFieldReportWarningSchema),
  deferredChecks: z.array(z.object({ code: z.string(), owner: z.string() })),
});
export type ConcreteFieldReportReview = z.infer<typeof concreteFieldReportReviewSchema>;

export const concreteDuplicateTicketSchema = z.object({
  reportId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  reportDate: z.string().nullable(),
  technicianName: z.string().nullable(),
});
export type ConcreteDuplicateTicket = z.infer<typeof concreteDuplicateTicketSchema>;
export const CONCRETE_DUPLICATE_TICKET_LIMIT = 10;

/**
 * MISC-08 review routing for scope `concrete_field`: the project's effective designated reviewers
 * (assignment, the lead's approval, eligibility and accepted membership, read live) and its lead.
 * `blocked` is set when nobody could review it now: review work waits until someone can (an
 * eligibility loss removes the person here at once), never routed to an ineligible person.
 */
export const concreteFieldReviewRoutingSchema = z.object({
  scope: z.literal('concrete_field'),
  designatedReviewers: z.array(personSnapshotSchema),
  leadProjectEngineer: personSnapshotSchema.nullable(),
  blocked: z.enum(['no_reviewer']).nullable(),
});
export type ConcreteFieldReviewRouting = z.infer<typeof concreteFieldReviewRoutingSchema>;

export const concreteFieldReportDetailSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  client: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The signed-in account that created it (may be LAB). */
  createdBy: personSnapshotSchema,
  /** The performing staff member credited (never LAB). */
  technician: personSnapshotSchema.nullable(),
  workflow: concreteWorkflowSchema,
  issuance: concreteIssuanceSchema,
  fields: concreteFieldReportFieldsSchema,
  /** The registry revision copied when the mix was chosen; never re-read from the live mix. */
  mixSnapshot: concreteMixSnapshotSchema.nullable(),
  /** Spec-column members that differ from the snapshot (manual changes), per column. */
  manualSpecChanges: z.object({
    projectSpec: z.array(z.string()),
    ticketSpec: z.array(z.string()),
  }),
  airMeterUse: concreteEquipmentUseSchema.nullable(),
  duplicateTickets: z.array(concreteDuplicateTicketSchema),
  completeness: concreteDraftCompletenessSchema,
  review: concreteFieldReportReviewSchema,
  reviewRouting: concreteFieldReviewRoutingSchema,
  /**
   * Whether the caller may save this report now: a draft, or a report returned for correction
   * (MM-V2-C09), that is their own (LAB: for its technician).
   */
  canEdit: z.boolean(),
  /** Versions, review and issue (MM-V2-C09), as the server holds them. */
  lifecycle: concreteReportLifecycleSchema,
});
export type ConcreteFieldReportDetail = z.infer<typeof concreteFieldReportDetailSchema>;

export const concreteFieldReportSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  reportDate: z.string().nullable(),
  technician: personSnapshotSchema.nullable(),
  supplierName: z.string().nullable(),
  mixNumber: z.string().nullable(),
  ticketNumber: z.string().nullable(),
  workflowState: z.string(),
  /** MM-V2-C30 (Reports tab): the report type, structure / elements, location and issue. */
  reportType: z.literal('field'),
  paperFieldId: z.string().nullable(),
  locationElements: z.array(z.string()),
  locationElementOther: z.string().nullable(),
  locationDescription: z.string().nullable(),
  issueCount: z.number(),
  lastIssuedAt: z.string().nullable(),
  completeness: concreteDraftCompletenessSchema,
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConcreteFieldReportSummary = z.infer<typeof concreteFieldReportSummarySchema>;

export const concreteFieldReportListSchema = z.object({
  projectId: z.string(),
  items: z.array(concreteFieldReportSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ConcreteFieldReportList = z.infer<typeof concreteFieldReportListSchema>;

export const concreteFieldReportVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteFieldReportDetailSchema,
});

// ---------------------------------------------------------------------------------------------
// Final-review rules (computed, never stored)
// ---------------------------------------------------------------------------------------------

export interface ConcreteFieldReportReviewInput {
  technicianUserId: string | null;
  fields: ConcreteFieldReportFields;
  mixSnapshot: ConcreteMixSnapshot | null;
  /**
   * MM-V2-C05: the report's specimen sets (derived specimen count and mould size). When cast,
   * review needs at least one set with specimens, each with its mould size. Omitted: not checked.
   */
  specimenSets?: readonly { id: string; specimenCount: number; mouldSize: string | null }[];
}

/**
 * The field paths the final review needs that are still missing (spec page 2 "Required").
 * Conditional rows apply only when their condition holds (retest → its value and time; Yes →
 * who; Other → its text; specimens cast → cast time). Client, project name and job number come
 * from the project record, which always has them.
 */
export function concreteFieldReportMissing(input: ConcreteFieldReportReviewInput): string[] {
  const f = input.fields;
  const missing: string[] = [];
  const need = (path: string, present: boolean) => {
    if (!present) missing.push(path);
  };
  const has = (value: unknown) => value !== null && value !== undefined;

  need('reportDate', has(f.reportDate));
  need('contractorName', has(f.contractorName));
  need('technicianUserId', has(input.technicianUserId));
  need('locationElements', f.locationElements.length > 0);
  if (
    f.locationElements.some(
      (e) => e.toLowerCase() === CONCRETE_LOCATION_ELEMENT_OTHER.toLowerCase(),
    )
  ) {
    need('locationElementOther', has(f.locationElementOther));
  }
  need('locationDescription', has(f.locationDescription));
  for (const field of [
    'supplierName',
    'mixNumber',
    'ticketNumber',
    'truckNumber',
    'plantName',
    'batchedAt',
    'loadVolumeM3',
    'cumulativeVolumeM3',
  ] as const) {
    need(field, has(f[field]));
  }
  for (const column of ['projectSpec', 'ticketSpec'] as const) {
    for (const field of CONCRETE_REPORT_SPEC_REQUIRED)
      need(`${column}.${field}`, has(f[column][field]));
  }
  need('arrivedAt', has(f.arrivedAt));
  need('sampledAt', has(f.sampledAt));
  need('testedAt', has(f.testedAt));
  need('timeLimitExceeded', has(f.timeLimitExceeded));
  if (f.timeLimitExceeded === true) need('timeLimitInformed', has(f.timeLimitInformed));
  need('loadRejected', has(f.loadRejected));
  need('loadDecisionByName', has(f.loadDecisionByName));
  need('loadDecisionByCompany', has(f.loadDecisionByCompany));
  need('samplingLocation', has(f.samplingLocation));
  if (f.samplingLocation === 'other') need('samplingLocationOther', has(f.samplingLocationOther));
  need('placementMethods', f.placementMethods.length > 0);
  if (f.placementMethods.includes('other'))
    need('placementMethodOther', has(f.placementMethodOther));
  need('material', has(f.material));
  need('superplasticizerAdded', has(f.superplasticizerAdded));

  const initial = (test: ConcreteReadingTest) =>
    f.readings.find((r) => r.test === test && r.context === 'initial');
  need('readings.slump.initial', has(initial('slump')?.value));
  // Air is always required for routine concrete; other materials' rules are open.
  if (f.material === 'concrete') need('readings.air.initial', has(initial('air')?.value));
  for (const reading of f.readings) {
    if (reading.context === 'initial') continue;
    need(`readings.${reading.id}.value`, has(reading.value));
    need(`readings.${reading.id}.measuredAt`, has(reading.measuredAt));
  }

  need('concreteTempC', has(f.concreteTempC));
  need('ambientTempC', has(f.ambientTempC));
  need('waterAdded', has(f.waterAdded));
  if (f.waterAdded === true) need('waterAddedAuthorizedBy', has(f.waterAddedAuthorizedBy));
  need('specimensCast', has(f.specimensCast));
  if (f.specimensCast === true) need('castAt', has(f.castAt));
  if (f.specimensCast === true && input.specimenSets) {
    const cast = input.specimenSets.filter((set) => set.specimenCount > 0);
    need('specimenSets', cast.length > 0);
    for (const set of cast) need(`specimenSets.${set.id}.mouldSize`, has(set.mouldSize));
  }
  need('resultsReportedToName', has(f.resultsReportedToName));
  need('resultsReportedToCompany', has(f.resultsReportedToCompany));
  // CD-14: at least one ticket attachment (its acknowledgment is C15's).
  need('attachmentRefs', f.attachmentRefs.length > 0);
  return missing;
}

export function concreteFieldReportCompleteness(
  input: ConcreteFieldReportReviewInput,
): ConcreteDraftCompleteness {
  const missingRequired = concreteFieldReportMissing(input);
  return { complete: missingRequired.length === 0, missingRequired };
}

/**
 * Warnings the record itself shows (spec page 1, right column). The server adds those that need
 * other records: duplicate supplier + ticket and air-meter calibration flags.
 */
export function concreteFieldReportWarnings(
  input: ConcreteFieldReportReviewInput,
): ConcreteFieldReportWarning[] {
  const f = input.fields;
  const warnings: ConcreteFieldReportWarning[] = [];
  if (f.mixId === null && (f.mixNumber !== null || f.supplierName !== null)) {
    warnings.push({
      code: 'unknown_mix',
      field: 'mixNumber',
      message: 'The mix is not in the project registry (CD-15)',
    });
  }
  if (input.mixSnapshot && input.mixSnapshot.revisionState === 'draft') {
    warnings.push({
      code: 'unapproved_mix',
      field: 'mixId',
      message: 'The mix was not approved when it was chosen (CD-15)',
    });
  }
  const spec = f.projectSpec;
  for (const reading of f.readings) {
    if (reading.value === null) continue;
    if (
      reading.test === 'slump' &&
      spec.slumpTargetMm !== null &&
      spec.slumpToleranceMm !== null &&
      Math.abs(reading.value - spec.slumpTargetMm) > spec.slumpToleranceMm + 1e-9
    ) {
      warnings.push({
        code: 'slump_out_of_range',
        field: `readings.${reading.id}.value`,
        message: `Slump ${reading.value} mm is outside ${spec.slumpTargetMm} ± ${spec.slumpToleranceMm} mm`,
      });
    }
    if (
      reading.test === 'air' &&
      ((spec.airMinPercent !== null && reading.value < spec.airMinPercent) ||
        (spec.airMaxPercent !== null && reading.value > spec.airMaxPercent))
    ) {
      warnings.push({
        code: 'air_out_of_range',
        field: `readings.${reading.id}.value`,
        message: `Air ${reading.value} % is outside ${spec.airMinPercent ?? '–'}–${spec.airMaxPercent ?? '–'} %`,
      });
    }
  }
  for (const field of CONCRETE_REPORT_SPEC_REQUIRED) {
    const ticket = f.ticketSpec[field];
    const project = f.projectSpec[field];
    if (
      ticket !== null &&
      project !== null &&
      String(ticket).toLowerCase() !== String(project).toLowerCase()
    ) {
      warnings.push({
        code: 'ticket_differs_from_spec',
        field: `ticketSpec.${field}`,
        message: 'The ticket differs from the project specification',
      });
    }
  }
  // MM-V2-C05: "No" never silently deletes specimens already recorded (combined plan, Specimens).
  if (f.specimensCast === false && input.specimenSets?.some((set) => set.specimenCount > 0)) {
    warnings.push({
      code: 'specimens_recorded_but_not_cast',
      field: 'specimensCast',
      message: 'Specimens cast is No, but this report still has specimens recorded',
    });
  }
  return warnings;
}

/** Spec-column members that differ from the snapshot the column was filled from. */
export function concreteReportManualSpecChanges(
  fields: Pick<ConcreteFieldReportFields, 'projectSpec' | 'ticketSpec'>,
  snapshot: ConcreteMixSnapshot | null,
): { projectSpec: string[]; ticketSpec: string[] } {
  if (!snapshot) return { projectSpec: [], ticketSpec: [] };
  const fromMix = concreteReportSpecFromMix(snapshot);
  const diff = (a: ConcreteReportSpecColumn, b: ConcreteReportSpecColumn) =>
    (Object.keys(a) as (keyof ConcreteReportSpecColumn)[]).filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
  return {
    projectSpec: diff(fields.projectSpec, fromMix.projectSpec),
    ticketSpec: diff(fields.ticketSpec, fromMix.ticketSpec),
  };
}

/** The two spec columns as the mix snapshot fills them. */
export function concreteReportSpecFromMix(snapshot: ConcreteMixSnapshot): {
  projectSpec: ConcreteReportSpecColumn;
  ticketSpec: ConcreteReportSpecColumn;
} {
  const s = snapshot.spec;
  const t = s.ticketDefaults;
  return {
    projectSpec: {
      specifiedStrengthMpa: s.specifiedStrengthMpa,
      specifiedStrengthAgeDays: s.specifiedStrengthAgeDays,
      slumpTargetMm: s.slumpTargetMm,
      slumpToleranceMm: s.slumpToleranceMm,
      airMinPercent: s.airMinPercent,
      airMaxPercent: s.airMaxPercent,
      maxAggregateSizeMm: s.maxAggregateSizeMm,
      cementType: s.cementType,
      admixtures: s.specAdmixtures,
    },
    ticketSpec: {
      specifiedStrengthMpa: t.specifiedStrengthMpa,
      specifiedStrengthAgeDays: null,
      slumpTargetMm: t.slumpTargetMm,
      slumpToleranceMm: t.slumpToleranceMm,
      airMinPercent: t.airMinPercent,
      airMaxPercent: t.airMaxPercent,
      maxAggregateSizeMm: t.maxAggregateSizeMm,
      cementType: t.cementType,
      admixtures: t.admixtures,
    },
  };
}
