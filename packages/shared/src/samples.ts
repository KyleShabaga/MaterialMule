import { z } from 'zod';

// Sampling sources, Shelby tube sample identity and bulk-sample groups (MM-T36).
//
// A sampling source is where material came from: a test hole in the same project, or a
// standalone sampling location typed as free text on that unit (no directory of locations, and
// equal text never merges two sources). It is never the unit's current storage location.
//
// A Shelby tube carries its own source plus an optional sample reference and depth. A bulk soil
// bucket belongs to exactly one bulk group, which holds the identity once for all its buckets:
// source, sample reference (usually B1, B2…, never forced), depth with units and an optional
// description. B1 alone identifies nothing: another hole or location may have its own B1.

export const SAMPLING_SOURCE_TYPES = ['test_hole', 'standalone_location'] as const;
export type SamplingSourceType = (typeof SAMPLING_SOURCE_TYPES)[number];

export const SAMPLING_SOURCE_TYPE_LABEL: Record<SamplingSourceType, string> = {
  test_hole: 'Test hole',
  standalone_location: 'Standalone sampling location',
};

export const SAMPLE_REFERENCE_MAX_LENGTH = 40;
export const SOURCE_LOCATION_REFERENCE_MAX_LENGTH = 100;
export const BULK_GROUP_DESCRIPTION_MAX_LENGTH = 500;
/** Minimum length of the reason a group correction needs (same rule as unit corrections). */
export const BULK_GROUP_REASON_MIN_LENGTH = 5;

/** Largest depth `numeric(8, 2)` can hold. */
const MAX_DEPTH = 999_999.99;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Trimmed optional text: absent, null and blank all become null. */
const optionalText = (max: number) =>
  z
    .string({ error: 'must be text' })
    .trim()
    .max(max, { error: `must be at most ${max} characters` })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      error: "can't contain control characters",
    })
    .nullish()
    .transform((value) => (value ? value : null));

const depthValue = z
  .number({ error: 'must be a number' })
  .min(0, { error: 'must be 0 or more' })
  .max(MAX_DEPTH, { error: `must be at most ${MAX_DEPTH}` })
  .refine((value) => Math.round(value * 100) / 100 === value, {
    error: 'must have at most two decimal places',
    params: { code: 'too_precise' },
  })
  .nullish()
  .transform((value) => value ?? null);

const identityFields = {
  sourceType: z.enum(SAMPLING_SOURCE_TYPES, {
    error: 'must be test_hole or standalone_location',
  }),
  testHoleId: z
    .uuid({ error: 'must be a test hole ID' })
    .nullish()
    .transform((value) => value ?? null),
  sourceLocationReference: optionalText(SOURCE_LOCATION_REFERENCE_MAX_LENGTH),
  sampleReference: optionalText(SAMPLE_REFERENCE_MAX_LENGTH),
  depthFrom: depthValue,
  depthTo: depthValue,
  depthUnit: z
    .enum(['ft', 'm'], { error: 'must be ft or m' })
    .nullish()
    .transform((value) => value ?? null),
};

type IdentityValues = {
  sourceType: SamplingSourceType;
  testHoleId: string | null;
  sourceLocationReference: string | null;
  sampleReference: string | null;
  depthFrom: number | null;
  depthTo: number | null;
  depthUnit: 'ft' | 'm' | null;
};

/**
 * Shape rules shared by a Shelby tube's sample and a bulk group's identity, matching the
 * database checks (storage_unit, bulk_group). Bulk identities also need a sample reference and a depth.
 */
function checkIdentity(
  value: IdentityValues,
  ctx: z.RefinementCtx,
  required: { sampleReference: boolean; depth: boolean },
) {
  const issue = (field: string, code: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [field], message, params: { code } });
  if (value.sourceType === 'test_hole') {
    if (value.testHoleId === null) issue('testHoleId', 'required', 'is required');
    if (value.sourceLocationReference !== null) {
      issue(
        'sourceLocationReference',
        'conflicting_source',
        'must be empty for a test hole source',
      );
    }
  } else {
    if (value.sourceLocationReference === null) {
      issue('sourceLocationReference', 'required', 'is required');
    }
    if (value.testHoleId !== null) {
      issue('testHoleId', 'conflicting_source', 'must be empty for a standalone location source');
    }
  }
  if (required.sampleReference && value.sampleReference === null) {
    issue('sampleReference', 'required', 'is required');
  }
  if (value.depthFrom === null) {
    if (required.depth) issue('depthFrom', 'required', 'is required');
    else if (value.depthTo !== null) issue('depthFrom', 'required', 'is required with depth to');
    else if (value.depthUnit !== null) issue('depthUnit', 'not_allowed', 'needs a depth');
  }
  if ((value.depthFrom !== null || required.depth) && value.depthUnit === null) {
    issue('depthUnit', 'required', 'is required (ft or m)');
  }
  if (value.depthFrom !== null && value.depthTo !== null && value.depthTo < value.depthFrom) {
    issue('depthTo', 'depth_range_reversed', 'must be greater than or equal to depth from');
  }
}

/**
 * A Shelby tube's sampling source and, where supplied, its sample reference (e.g. T5) and depth
 * or depth interval with units. One tube is one storage unit whatever its source.
 */
export const shelbySampleInputSchema = z
  .strictObject(identityFields, { error: 'must be an object' })
  .superRefine((value, ctx) => checkIdentity(value, ctx, { sampleReference: false, depth: false }));
export type ShelbySampleInput = z.output<typeof shelbySampleInputSchema>;

/** A new bulk group's identity: source, sample reference, depth with units, description. */
export const bulkSampleIdentityInputSchema = z
  .strictObject(
    { ...identityFields, description: optionalText(BULK_GROUP_DESCRIPTION_MAX_LENGTH) },
    { error: 'must be an object' },
  )
  .superRefine((value, ctx) => checkIdentity(value, ctx, { sampleReference: true, depth: true }));
export type BulkSampleIdentityInput = z.output<typeof bulkSampleIdentityInputSchema>;

/**
 * A bulk group created by a receipt (`bulkGroups` in `POST /api/receipts`). Declared once and
 * referenced by `key` from each of its buckets, so two buckets of a new sample share one group.
 */
export const newBulkGroupInputSchema = z
  .strictObject(
    {
      key: z
        .string({ error: 'is required' })
        .trim()
        .min(1, { error: 'is required' })
        .max(64, { error: 'must be at most 64 characters' }),
      ...identityFields,
      description: optionalText(BULK_GROUP_DESCRIPTION_MAX_LENGTH),
    },
    { error: 'must be an object' },
  )
  .superRefine((value, ctx) => checkIdentity(value, ctx, { sampleReference: true, depth: true }));
export type NewBulkGroupInput = z.output<typeof newBulkGroupInputSchema>;

/**
 * Which group a receipt's bulk soil bucket belongs to: a new one declared in this receipt
 * (`newGroupKey`), or an existing group of the project at the identity version the receiver saw
 * (`existingId` + `version`). Joining inherits the group's identity: nothing else is sent.
 */
export const receiptBulkGroupRefSchema = z
  .strictObject(
    {
      newGroupKey: z
        .string({ error: 'must be text' })
        .trim()
        .min(1, { error: 'is required' })
        .max(64, { error: 'must be at most 64 characters' })
        .optional(),
      existingId: z.uuid({ error: 'must be a bulk sample ID' }).optional(),
      version: z
        .number({ error: 'must be a number' })
        .int({ error: 'must be a whole number' })
        .min(1, { error: 'must be 1 or more' })
        .optional(),
    },
    { error: 'must be an object' },
  )
  .superRefine((value, ctx) => {
    const issue = (field: string, code: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message, params: { code } });
    if (value.newGroupKey !== undefined) {
      if (value.existingId !== undefined || value.version !== undefined) {
        issue('existingId', 'conflicting_group', 'must be empty for a new bulk sample');
      }
    } else if (value.existingId === undefined) {
      issue('existingId', 'required', 'choose a bulk sample');
    } else if (value.version === undefined) {
      issue('version', 'required', 'is required when joining a bulk sample');
    }
  });
export type ReceiptBulkGroupRef = z.output<typeof receiptBulkGroupRefSchema>;

// ---------------------------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------------------------

export const samplingSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('test_hole'), testHoleId: z.string(), testHoleName: z.string() }),
  z.object({ type: z.literal('standalone_location'), locationReference: z.string() }),
]);
export type SamplingSource = z.infer<typeof samplingSourceSchema>;

/** Source plus sample reference and depth: a Shelby tube's own, or a bulk group's. */
export const sampleIdentitySchema = z.object({
  source: samplingSourceSchema,
  sampleReference: z.string().nullable(),
  depthFrom: z.number().nullable(),
  depthTo: z.number().nullable(),
  depthUnit: z.enum(['ft', 'm']).nullable(),
});
export type SampleIdentity = z.infer<typeof sampleIdentitySchema>;

/** A bulk group as pickers list it: `GET /api/projects/:id/bulk-groups`. */
export const bulkGroupSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  identity: sampleIdentitySchema,
  description: z.string().nullable(),
  /** Physical buckets currently in the group. */
  memberCount: z.number(),
  /** Identity version; a receipt joining the group sends the version it showed. */
  version: z.number(),
});
export type BulkGroupSummary = z.infer<typeof bulkGroupSummarySchema>;
export const bulkGroupListSchema = z.array(bulkGroupSummarySchema);

/** A unit's place in its group: "bucket n of N", worked out when read. */
export const bulkMembershipSchema = z.object({
  groupId: z.string(),
  /** 1-based, by received date then readable storage unit ID. */
  memberNumber: z.number(),
  memberCount: z.number(),
});
export type BulkMembership = z.infer<typeof bulkMembershipSchema>;

/** One bucket of a group, on a member's detail page. */
export const bulkGroupMemberSchema = z.object({
  id: z.string(),
  readableId: z.string(),
  status: z.enum(['in_stock', 'approved_for_disposal', 'disposed']),
  receivedDate: z.string(),
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }),
});
export type BulkGroupMember = z.infer<typeof bulkGroupMemberSchema>;

export const bulkGroupDetailSchema = bulkMembershipSchema.extend({
  description: z.string().nullable(),
  version: z.number(),
  /** Every bucket in the group, in "n of N" order, this one included. */
  members: z.array(bulkGroupMemberSchema),
});
export type BulkGroupDetail = z.infer<typeof bulkGroupDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Corrections (personal accounts only, with a reason; D45)
// ---------------------------------------------------------------------------------------------

const reasonSchema = z
  .string({ error: 'is required' })
  .trim()
  .min(BULK_GROUP_REASON_MIN_LENGTH, {
    error: `must be at least ${BULK_GROUP_REASON_MIN_LENGTH} characters`,
  })
  .max(2000, { error: 'must be at most 2000 characters' });

const versionSchema = z
  .number({ error: 'is required' })
  .int({ error: 'must be a whole number' })
  .min(1, { error: 'must be 1 or more' });

/**
 * `PATCH /api/storage-units/:id/bulk-group`: move a bulk soil bucket into another existing group
 * of its project (`groupId`), or into a new group of its own (`newGroup`). `groupId: null` is
 * refused (422 bulk_identity_required): a bulk soil bucket's only contents summary is its group.
 */
export const changeBulkGroupRequestSchema = z
  .strictObject(
    {
      /** The unit's version when the form was opened. */
      version: versionSchema,
      reason: reasonSchema,
      groupId: z.uuid({ error: 'must be a bulk sample ID' }).nullable().optional(),
      newGroup: bulkSampleIdentityInputSchema.optional(),
    },
    { error: 'must be an object' },
  )
  .superRefine((request, ctx) => {
    const both = request.groupId !== undefined && request.newGroup !== undefined;
    const neither = request.groupId === undefined && request.newGroup === undefined;
    if (both || neither) {
      ctx.addIssue({
        code: 'custom',
        path: ['groupId'],
        message: 'choose an existing bulk sample or describe a new one',
        params: { code: both ? 'conflicting_group' : 'required' },
      });
    }
  });
export type ChangeBulkGroupRequest = z.output<typeof changeBulkGroupRequestSchema>;
export type ChangeBulkGroupRequestInput = z.input<typeof changeBulkGroupRequestSchema>;

/**
 * `PATCH /api/bulk-groups/:id`: correct a group's identity. Every member bucket shows the new
 * identity at once; the old one stays in the audit history.
 */
export const correctBulkGroupRequestSchema = z.strictObject(
  { version: versionSchema, reason: reasonSchema, identity: bulkSampleIdentityInputSchema },
  { error: 'must be an object' },
);
export type CorrectBulkGroupRequest = z.output<typeof correctBulkGroupRequestSchema>;
export type CorrectBulkGroupRequestInput = z.input<typeof correctBulkGroupRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

export function samplingSourceName(source: SamplingSource): string {
  return source.type === 'test_hole' ? source.testHoleName : source.locationReference;
}

/** "1.5–2 m", "3 ft" (a single depth) or "" when none was supplied. */
export function formatDepth(
  depthFrom: number | null,
  depthTo: number | null,
  depthUnit: 'ft' | 'm' | null,
): string {
  if (depthFrom === null) return '';
  const range = depthTo === null ? `${depthFrom}` : `${depthFrom}–${depthTo}`;
  return `${range} ${depthUnit ?? ''}`.trim();
}

/** "B1 at 1.5–2 m", "B1", "10–12 ft" or "": the identity without its source. */
export function formatSampleDetails(
  identity: Pick<SampleIdentity, 'sampleReference' | 'depthFrom' | 'depthTo' | 'depthUnit'>,
): string {
  const depth = formatDepth(identity.depthFrom, identity.depthTo, identity.depthUnit);
  return [identity.sampleReference, depth].filter(Boolean).join(' at ');
}

/**
 * The contents summary as people read it, e.g. "TH26-21: B1 at 1.5–2 m" or
 * "Embankment Location 03: T5". Inventory search matches this form (storage_unit_search_document).
 */
export function formatSampleIdentity(identity: SampleIdentity): string {
  const details = formatSampleDetails(identity);
  const source = samplingSourceName(identity.source);
  return details ? `${source}: ${details}` : source;
}

/** "bucket 1 of 2" */
export function formatBucketPosition(
  membership: Pick<BulkMembership, 'memberNumber' | 'memberCount'>,
) {
  return `bucket ${membership.memberNumber} of ${membership.memberCount}`;
}

/** "Bulk sample · B1 · bucket 1 of 2" */
export function formatBulkBadge(
  identity: Pick<SampleIdentity, 'sampleReference'>,
  membership: Pick<BulkMembership, 'memberNumber' | 'memberCount'>,
): string {
  return ['Bulk sample', identity.sampleReference, formatBucketPosition(membership)]
    .filter(Boolean)
    .join(' · ');
}

/** "TH26-21 · B1 · 1.5–2 m — 2 buckets so far", as the receiving picker offers a group. */
export function bulkGroupOptionLabel(
  group: Pick<BulkGroupSummary, 'identity' | 'memberCount'>,
): string {
  const { identity } = group;
  const parts = [
    samplingSourceName(identity.source),
    identity.sampleReference,
    formatDepth(identity.depthFrom, identity.depthTo, identity.depthUnit),
  ].filter(Boolean);
  const count = `${group.memberCount} bucket${group.memberCount === 1 ? '' : 's'} so far`;
  return `${parts.join(' · ')} — ${count}`;
}
