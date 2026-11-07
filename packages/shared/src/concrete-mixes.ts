import { z } from 'zod';
import { CONCRETE_SETTINGS_DEFAULTS, concreteSpecimenAgesSchema } from './concrete-settings';
import { personSnapshotSchema } from './lab-programs';

// Project concrete mixes (MM-V2-C03, migration 0017). Decisions: CD-52 (mixes are project-specific;
// only the project's Lead Project Engineer creates, edits, copies or approves; a copy starts
// Unapproved; new mixes default to 7/28/28/HOLD; D14: editing an approved mix makes a draft
// revision and the approved one stays in effect until the Lead approves), CD-17 (slump = target ±
// tolerance mm, air = min–max %), CD-15 (an unknown or unapproved mix on a field report is
// flagged, never a registry edit). Spec field map: "Mix spec vs ticket" and "Admixtures".
//
// Missing draft data is null, never 0 or None. No value limits are hardcoded: 80 ± 30 mm and
// 5–8 % are format examples only.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const idSchema = z.uuid({ error: 'must be an ID' });

function label(name: string, max: number) {
  return z
    .string({ error: `${name} must be text` })
    .trim()
    .min(1, { error: `Enter the ${name.toLowerCase()}` })
    .max(max, { error: `${name} must be ${max} characters or fewer` })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: `${name} can't contain control characters`,
    });
}

/** A decimal with at most `places` decimal places, within [min, max] (exclusive min if asked). */
function measure(
  name: string,
  {
    min,
    max,
    places,
    exclusiveMin = false,
  }: {
    min: number;
    max: number;
    places: number;
    exclusiveMin?: boolean;
  },
) {
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
    });
}

export const concreteMixSupplierSchema = label('Supplier', 200);
/** Text, so leading zeros are kept (field map: identifiers are text). */
export const concreteMixNumberSchema = label('Mix number', 100);
export const concreteMixPlantSchema = label('Plant', 200);
export const concreteMixPlantsSchema = z
  .array(concreteMixPlantSchema, { error: 'Plants must be a list' })
  .max(20, { error: 'Give at most 20 plants' })
  .refine((plants) => new Set(plants.map((p) => p.toLowerCase())).size === plants.length, {
    message: 'Each plant once',
  });

export const concreteStrengthMpaSchema = measure('Strength', {
  min: 0,
  max: 9999.99,
  places: 2,
  exclusiveMin: true,
});
export const concreteStrengthAgeDaysSchema = z
  .number({ error: 'Strength age must be a number of days' })
  .int({ error: 'Strength age must be a whole number of days' })
  .min(1, { error: 'Strength age must be at least 1 day' })
  .max(999, { error: 'Strength age must be 999 days or fewer' });
export const concreteSlumpMmSchema = measure('Slump', { min: 0, max: 99999.9, places: 1 });
export const concreteSlumpToleranceMmSchema = measure('Slump tolerance', {
  min: 0,
  max: 99999.9,
  places: 1,
});
export const concreteAirPercentSchema = measure('Air', { min: 0, max: 100, places: 1 });
export const concreteAggregateSizeMmSchema = measure('Aggregate size', {
  min: 0,
  max: 99999.9,
  places: 1,
  exclusiveMin: true,
});
export const concreteCementTypeSchema = label('Cement type', 100);

// ---------------------------------------------------------------------------------------------
// Admixtures (field map "Admixtures": ticket and project spec are separate sections)
// ---------------------------------------------------------------------------------------------

export const CONCRETE_ADMIXTURE_KINDS = [
  'superplasticizer',
  'fibres',
  'accelerator',
  'ice',
  'winter_heat',
  'air',
  'retarder',
  'corrosion_inhibitor',
  'pigment',
  'other',
] as const;
export type ConcreteAdmixtureKind = (typeof CONCRETE_ADMIXTURE_KINDS)[number];

/** Dosage units where the field sheet prints one; the others are present/absent only. */
export const CONCRETE_ADMIXTURE_DOSAGE_UNIT: Partial<Record<ConcreteAdmixtureKind, string>> = {
  superplasticizer: 'L/m³',
  fibres: 'kg/m³',
};

export const concreteAdmixtureItemSchema = z
  .strictObject({
    kind: z.enum(CONCRETE_ADMIXTURE_KINDS, { error: 'Choose an admixture' }),
    /** Only for superplasticizer (L/m³) and fibres (kg/m³); null = not given. */
    dosage: measure('Dosage', { min: 0, max: 99999.99, places: 2 }).nullable().default(null),
    /** Only for Other. Whether it is mandatory is open (dosage rules), so it is optional. */
    description: label('Description', 200).nullable().default(null),
  })
  .superRefine((item, ctx) => {
    if (item.dosage !== null && !CONCRETE_ADMIXTURE_DOSAGE_UNIT[item.kind]) {
      ctx.addIssue({ code: 'custom', path: ['dosage'], message: 'No dosage for this admixture' });
    }
    if (item.description !== null && item.kind !== 'other') {
      ctx.addIssue({
        code: 'custom',
        path: ['description'],
        message: 'Only Other has a description',
      });
    }
  });
export type ConcreteAdmixtureItem = z.output<typeof concreteAdmixtureItemSchema>;

/**
 * One admixture section. `declaration`: null = not answered yet; `none` and `unknown` are
 * answers (never the same as blank); `listed` names at least one admixture.
 */
export const concreteAdmixturesSchema = z
  .strictObject({
    declaration: z
      .enum(['listed', 'none', 'unknown'], { error: 'Choose listed, None or Unknown' })
      .nullable()
      .default(null),
    items: z.array(concreteAdmixtureItemSchema).max(CONCRETE_ADMIXTURE_KINDS.length).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.declaration === 'listed' && value.items.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Add at least one admixture' });
    }
    if (value.declaration !== 'listed' && value.items.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['declaration'],
        message: 'Choose listed to name admixtures',
      });
    }
    if (new Set(value.items.map((item) => item.kind)).size !== value.items.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each admixture once' });
    }
  });
export type ConcreteAdmixtures = z.output<typeof concreteAdmixturesSchema>;
export const CONCRETE_ADMIXTURES_NOT_ANSWERED: ConcreteAdmixtures = {
  declaration: null,
  items: [],
};

// ---------------------------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------------------------

/**
 * Supplier-ticket defaults: what the field form pre-fills in the ticket column (strength, slump,
 * air, aggregate, cement, admixtures). Defaults only, never evidence a ticket was checked.
 */
export const concreteMixTicketDefaultsSchema = z.strictObject({
  specifiedStrengthMpa: concreteStrengthMpaSchema.nullable().default(null),
  slumpTargetMm: concreteSlumpMmSchema.nullable().default(null),
  slumpToleranceMm: concreteSlumpToleranceMmSchema.nullable().default(null),
  airMinPercent: concreteAirPercentSchema.nullable().default(null),
  airMaxPercent: concreteAirPercentSchema.nullable().default(null),
  maxAggregateSizeMm: concreteAggregateSizeMmSchema.nullable().default(null),
  cementType: concreteCementTypeSchema.nullable().default(null),
  admixtures: concreteAdmixturesSchema.default(CONCRETE_ADMIXTURES_NOT_ANSWERED),
});
export type ConcreteMixTicketDefaults = z.output<typeof concreteMixTicketDefaultsSchema>;

const specFields = {
  supplierName: concreteMixSupplierSchema,
  mixNumber: concreteMixNumberSchema,
  plantNames: concreteMixPlantsSchema,
  specifiedStrengthMpa: concreteStrengthMpaSchema.nullable(),
  /** Optional (AC1): the age the strength is specified at, separate from the test ages. */
  specifiedStrengthAgeDays: concreteStrengthAgeDaysSchema.nullable(),
  slumpTargetMm: concreteSlumpMmSchema.nullable(),
  slumpToleranceMm: concreteSlumpToleranceMmSchema.nullable(),
  airMinPercent: concreteAirPercentSchema.nullable(),
  airMaxPercent: concreteAirPercentSchema.nullable(),
  maxAggregateSizeMm: concreteAggregateSizeMmSchema.nullable(),
  cementType: concreteCementTypeSchema.nullable(),
  specAdmixtures: concreteAdmixturesSchema,
  ticketDefaults: concreteMixTicketDefaultsSchema,
  /** One entry per specimen: days or HOLD; repeats (28, 28) are distinct entries. */
  testAges: concreteSpecimenAgesSchema,
};

export const CONCRETE_MIX_SPEC_FIELDS = Object.keys(specFields) as (keyof typeof specFields)[];
export type ConcreteMixSpecField = (typeof CONCRETE_MIX_SPEC_FIELDS)[number];

function airRange(
  value: { airMinPercent?: number | null; airMaxPercent?: number | null },
  ctx: z.RefinementCtx,
  path: (string | number)[] = [],
) {
  if (
    value.airMinPercent !== null &&
    value.airMinPercent !== undefined &&
    value.airMaxPercent !== null &&
    value.airMaxPercent !== undefined &&
    value.airMinPercent > value.airMaxPercent
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'airMaxPercent'],
      message: 'Air maximum must be at least the minimum',
    });
  }
}

/** A full specification (as stored on a revision). Drafts may leave values null. */
export const concreteMixSpecSchema = z.object(specFields).superRefine((value, ctx) => {
  airRange(value, ctx);
  airRange(value.ticketDefaults, ctx, ['ticketDefaults']);
});
export type ConcreteMixSpec = z.output<typeof concreteMixSpecSchema>;

/** Fields an approval needs (the database checks the same set). Strength age stays optional. */
export const CONCRETE_MIX_APPROVAL_REQUIRED_FIELDS = [
  'specifiedStrengthMpa',
  'slumpTargetMm',
  'slumpToleranceMm',
  'airMinPercent',
  'airMaxPercent',
  'maxAggregateSizeMm',
  'cementType',
] as const satisfies readonly ConcreteMixSpecField[];

/** The required fields still missing before `spec` can be approved (empty: approvable). */
export function concreteMixMissingForApproval(spec: ConcreteMixSpec): ConcreteMixSpecField[] {
  return CONCRETE_MIX_APPROVAL_REQUIRED_FIELDS.filter((field) => spec[field] === null);
}

/** What a new mix starts with when a value isn't given (test ages: see `create` below). */
export const CONCRETE_MIX_SPEC_DEFAULTS = {
  plantNames: [] as string[],
  specifiedStrengthMpa: null,
  specifiedStrengthAgeDays: null,
  slumpTargetMm: null,
  slumpToleranceMm: null,
  airMinPercent: null,
  airMaxPercent: null,
  maxAggregateSizeMm: null,
  cementType: null,
  specAdmixtures: CONCRETE_ADMIXTURES_NOT_ANSWERED,
  ticketDefaults: concreteMixTicketDefaultsSchema.parse({}),
  /** CD-52 / AC1: new mixes default to 7 / 28 / 28 / HOLD. */
  testAges: [...CONCRETE_SETTINGS_DEFAULTS.defaultSpecimenAges],
} as const;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** Optional note kept with the audit event (no rule requires one; owner review). */
export const concreteMixNoteSchema = z
  .string({ error: 'Note must be text' })
  .trim()
  .max(2000, { error: 'Note must be 2000 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
    message: "Note can't contain control characters",
  })
  .transform((value) => (value === '' ? null : value))
  .nullish();

const specInputBase = z.strictObject({
  supplierName: specFields.supplierName,
  mixNumber: specFields.mixNumber,
  plantNames: specFields.plantNames.optional(),
  specifiedStrengthMpa: specFields.specifiedStrengthMpa.optional(),
  specifiedStrengthAgeDays: specFields.specifiedStrengthAgeDays.optional(),
  slumpTargetMm: specFields.slumpTargetMm.optional(),
  slumpToleranceMm: specFields.slumpToleranceMm.optional(),
  airMinPercent: specFields.airMinPercent.optional(),
  airMaxPercent: specFields.airMaxPercent.optional(),
  maxAggregateSizeMm: specFields.maxAggregateSizeMm.optional(),
  cementType: specFields.cementType.optional(),
  specAdmixtures: specFields.specAdmixtures.optional(),
  ticketDefaults: specFields.ticketDefaults.optional(),
  testAges: specFields.testAges.optional(),
});

function checkAir(
  value: {
    airMinPercent?: number | null;
    airMaxPercent?: number | null;
    ticketDefaults?: ConcreteMixTicketDefaults;
  },
  ctx: z.RefinementCtx,
) {
  airRange(value, ctx);
  if (value.ticketDefaults) airRange(value.ticketDefaults, ctx, ['ticketDefaults']);
}

const specInput = specInputBase.superRefine(checkAir);

/**
 * `POST /api/projects/:projectId/concrete-mixes` (`concrete_mix.manage`: the project's Lead
 * Project Engineer only). Starts revision 1 as a draft (Unapproved). Supplier and mix number are
 * required; everything else may wait. Omitted test ages default to 7 / 28 / 28 / HOLD.
 */
export const createConcreteMixRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  spec: specInput,
  note: concreteMixNoteSchema,
});
export type CreateConcreteMixRequest = z.input<typeof createConcreteMixRequestSchema>;

/**
 * `PATCH /api/concrete-mixes/:id` (`concrete_mix.manage`). `version` is the mix's, as last read.
 * Omitted fields are unchanged; null clears a value; a given section (`specAdmixtures`,
 * `ticketDefaults`, `plantNames`, `testAges`) replaces the stored one whole. With an open draft the draft changes; with
 * only an approved revision a new draft revision is made from it (D14) and the approved revision
 * stays in effect. Field reports and sets are never touched.
 */
export const updateConcreteMixRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  version: z
    .number({ error: 'Version is required' })
    .int()
    .min(1, { error: 'Version is required' }),
  spec: specInputBase.partial().superRefine(checkAir),
  note: concreteMixNoteSchema,
});
export type UpdateConcreteMixRequest = z.input<typeof updateConcreteMixRequestSchema>;

/**
 * `POST /api/concrete-mixes/:id/approve` (`concrete_mix.approve`). Names the draft being approved,
 * so an approval never lands on a revision the Lead hasn't seen.
 */
export const approveConcreteMixRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  version: z
    .number({ error: 'Version is required' })
    .int()
    .min(1, { error: 'Version is required' }),
  revisionId: idSchema,
  note: concreteMixNoteSchema,
});
export type ApproveConcreteMixRequest = z.input<typeof approveConcreteMixRequestSchema>;

/**
 * `POST /api/projects/:projectId/concrete-mixes/copy` (`concrete_mix.manage` on the destination).
 * Copies the source's approved revision (or the named one; default: approved, else its draft)
 * into a new Unapproved mix. The source and its approval are never changed or copied.
 */
export const copyConcreteMixRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  sourceMixId: idSchema,
  sourceRevisionId: idSchema.optional(),
  note: concreteMixNoteSchema,
});
export type CopyConcreteMixRequest = z.input<typeof copyConcreteMixRequestSchema>;

export const CONCRETE_MIX_PAGE_SIZE_MAX = 100;

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(200).optional(),
);

/** `GET /api/projects/:projectId/concrete-mixes?supplier=&search=&status=&page=&pageSize=`. */
export const concreteMixListQuerySchema = z.object({
  /** Exact supplier (ignoring case): the field form's Supplier → Mix filter. */
  supplier: optionalText,
  /** Contains, ignoring case, in the mix number or supplier. */
  search: optionalText,
  status: z.enum(['unapproved', 'approved', 'revision_pending']).optional(),
  page: z.preprocess(
    (value) => (value === undefined ? 1 : Number(value)),
    z.number().int().min(1).max(100000),
  ),
  pageSize: z.preprocess(
    (value) => (value === undefined ? 50 : Number(value)),
    z.number().int().min(1).max(CONCRETE_MIX_PAGE_SIZE_MAX),
  ),
});
export type ConcreteMixListQuery = z.output<typeof concreteMixListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const CONCRETE_MIX_REVISION_STATES = ['draft', 'approved', 'superseded'] as const;
export type ConcreteMixRevisionState = (typeof CONCRETE_MIX_REVISION_STATES)[number];

/**
 * The mix as a whole: `unapproved` (no approved revision yet), `approved` (one in effect, no
 * draft) or `revision_pending` (one in effect and a draft revision awaiting the Lead, D14).
 */
export const CONCRETE_MIX_STATUSES = ['unapproved', 'approved', 'revision_pending'] as const;
export type ConcreteMixStatus = (typeof CONCRETE_MIX_STATUSES)[number];

export const concreteMixRevisionSchema = z.object({
  id: z.string(),
  revisionNumber: z.number(),
  state: z.enum(CONCRETE_MIX_REVISION_STATES),
  spec: concreteMixSpecSchema,
  createdAt: z.string(),
  createdBy: personSnapshotSchema,
  updatedAt: z.string(),
  approvedAt: z.string().nullable(),
  approvedBy: personSnapshotSchema.nullable(),
  supersededAt: z.string().nullable(),
  /** Required fields still null (empty for approved revisions). */
  missingForApproval: z.array(z.string()),
});
export type ConcreteMixRevision = z.infer<typeof concreteMixRevisionSchema>;

export const concreteMixCopySourceSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string(),
  mixId: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number(),
  supplierName: z.string(),
  mixNumber: z.string(),
});

export const concreteMixSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  supplierName: z.string(),
  mixNumber: z.string(),
  status: z.enum(CONCRETE_MIX_STATUSES),
  /** The approved revision in effect (null: Unapproved). */
  effectiveRevision: concreteMixRevisionSchema.nullable(),
  /** The open draft, if any. */
  draftRevision: concreteMixRevisionSchema.nullable(),
  copiedFrom: concreteMixCopySourceSchema.nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConcreteMixSummary = z.infer<typeof concreteMixSummarySchema>;

export const concreteMixListSchema = z.object({
  projectId: z.string(),
  items: z.array(concreteMixSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  /** `concrete_mix.manage` / `concrete_mix.approve` on this project, as it stands. */
  canManage: z.boolean(),
  canApprove: z.boolean(),
});
export type ConcreteMixList = z.infer<typeof concreteMixListSchema>;

/** One saved change to the mix, newest first. `before`/`after` hold only changed fields. */
export const concreteMixChangeSchema = z.object({
  id: z.string(),
  action: z.string(),
  occurredAt: z.string(),
  changedBy: personSnapshotSchema.nullable(),
  note: z.string().nullable(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
});
export type ConcreteMixChange = z.infer<typeof concreteMixChangeSchema>;

export const CONCRETE_MIX_HISTORY_LIMIT = 100;

/** `GET /api/concrete-mixes/:id` and every write's response. */
export const concreteMixDetailSchema = concreteMixSummarySchema.extend({
  projectNumber: z.string(),
  /** Every revision, newest first: the specification history. */
  revisions: z.array(concreteMixRevisionSchema),
  history: z.array(concreteMixChangeSchema),
  historyTotal: z.number(),
  canManage: z.boolean(),
  canApprove: z.boolean(),
});
export type ConcreteMixDetail = z.infer<typeof concreteMixDetailSchema>;

/** `GET /api/projects/:projectId/concrete-mix-suppliers`: for the Supplier → Mix → Plant pickers. */
export const CONCRETE_MIX_SUPPLIER_LIMIT = 200;
export const concreteMixSuppliersSchema = z.object({
  projectId: z.string(),
  suppliers: z.array(
    z.object({
      supplierName: z.string(),
      mixCount: z.number(),
      /** Plants named on the suppliers' mixes (latest revisions), sorted. */
      plantNames: z.array(z.string()),
    }),
  ),
  truncated: z.boolean(),
});
export type ConcreteMixSuppliers = z.infer<typeof concreteMixSuppliersSchema>;

/** 409 body when the mix changed since it was loaded. */
export const concreteMixVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteMixDetailSchema,
});
export type ConcreteMixVersionConflictResponse = z.infer<
  typeof concreteMixVersionConflictResponseSchema
>;

// ---------------------------------------------------------------------------------------------
// Downstream snapshot (C04 field reports, C05 specimen sets)
// ---------------------------------------------------------------------------------------------

/**
 * What a field report or specimen set records about the mix it used: the revision id (approved
 * revisions never change, so it stays a faithful reference) plus a copy of the values at the
 * time. Registry edits never rewrite a saved snapshot (AC5). A report that names an unknown mix
 * (CD-15) has no snapshot: it keeps its own manual entries and is flagged for review.
 */
export const concreteMixSnapshotSchema = z.object({
  mixId: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number(),
  /** The revision's state when captured: a draft (Unapproved) mix is flagged for review. */
  revisionState: z.enum(CONCRETE_MIX_REVISION_STATES),
  spec: concreteMixSpecSchema,
  capturedAt: z.string(),
});
export type ConcreteMixSnapshot = z.infer<typeof concreteMixSnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Propagation contract (card scope: defined here, not implemented; no route uses it yet)
// ---------------------------------------------------------------------------------------------

/**
 * Asking which existing records a newly approved revision could update. Later work (C30) builds
 * the preview and the screen; nothing changes an existing report or schedule without an explicit
 * per-item or Approve-all decision by the project's Lead.
 */
export const concreteMixPropagationRequestSchema = z.strictObject({
  mixId: idSchema,
  fromRevisionId: idSchema,
  toRevisionId: idSchema,
});
export type ConcreteMixPropagationRequest = z.infer<typeof concreteMixPropagationRequestSchema>;

/** Why an item can't be updated: measured data, tested specimens and issued reports never change. */
export const CONCRETE_MIX_PROPAGATION_INELIGIBLE = [
  'measured_value',
  'specimen_tested',
  'report_submitted',
  'report_issued',
  'manually_edited',
] as const;

export const concreteMixPropagationItemSchema = z.object({
  itemId: z.string(),
  recordType: z.enum(['field_report', 'specimen_set', 'specimen']),
  recordId: z.string(),
  /** Human label, e.g. the report reference or set ID. */
  recordLabel: z.string(),
  field: z.string(),
  before: z.unknown(),
  proposed: z.unknown(),
  eligible: z.boolean(),
  ineligibleReason: z.enum(CONCRETE_MIX_PROPAGATION_INELIGIBLE).nullable(),
});
export type ConcreteMixPropagationItem = z.infer<typeof concreteMixPropagationItemSchema>;

export const concreteMixPropagationPreviewSchema = z.object({
  previewId: z.string(),
  mixId: z.string(),
  fromRevisionId: z.string(),
  toRevisionId: z.string(),
  generatedAt: z.string(),
  items: z.array(concreteMixPropagationItemSchema),
});
export type ConcreteMixPropagationPreview = z.infer<typeof concreteMixPropagationPreviewSchema>;

/**
 * The Lead's decision on a preview: chosen items, or Approve all of the displayed list (its item
 * ids are sent back so an approval never covers an item the Lead didn't see). Ineligible items
 * are never applied.
 */
export const concreteMixPropagationDecisionSchema = z.strictObject({
  idempotencyKey: idSchema,
  previewId: idSchema,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('items'), itemIds: z.array(z.string()).min(1) }),
    z.strictObject({
      kind: z.literal('approve_all'),
      displayedItemIds: z.array(z.string()).min(1),
    }),
  ]),
  note: concreteMixNoteSchema,
});
export type ConcreteMixPropagationDecision = z.infer<typeof concreteMixPropagationDecisionSchema>;
