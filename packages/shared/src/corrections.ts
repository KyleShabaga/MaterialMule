import { z } from 'zod';
import {
  formatStorageUnitHoleSummary,
  storageUnitTypeLabel,
  STORAGE_UNIT_TYPES,
  type StorageUnitHoleSummary,
} from './inventory';
import { holeSummaryInputSchema } from './receipts';
import {
  formatBucketPosition,
  formatSampleIdentity,
  sampleIdentitySchema,
  shelbySampleInputSchema,
} from './samples';

// Corrections to a confirmed storage unit, `PATCH /api/storage-units/:id` (MM-T13, D45–D47).
// A correction changes current values only: the storage unit ID, saved location, print history
// and the original receipt header are never rewritten.

/**
 * Types a correction may set. Bucket only: a Shelby tube needs its own sampling source, which a
 * type correction doesn't carry (MM-T36). Setting a bulk soil bucket to Bucket, with its test
 * holes, makes it an ordinary bucket (MM-T82).
 */
export const CORRECTION_UNIT_TYPES = ['bucket'] as const;

/** Minimum length of the reason every correction needs. */
export const STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH = 5;

/** Fields a correction may change, in display order. */
export const STORAGE_UNIT_CORRECTION_FIELDS = [
  'unitType',
  'receivedDate',
  'project',
  'sample',
  'bulkGroup',
  'holeSummaries',
  'note',
] as const;
export type StorageUnitCorrectionField = (typeof STORAGE_UNIT_CORRECTION_FIELDS)[number];

export const storageUnitCorrectionRequestSchema = z
  .object({
    /** The unit's version when the form was opened; a stale version is refused with 409. */
    version: z
      .number({ error: 'is required' })
      .int({ error: 'must be a whole number' })
      .min(1, { error: 'must be 1 or more' }),
    reason: z
      .string({ error: 'is required' })
      .trim()
      .min(STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH, {
        error: `must be at least ${STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH} characters`,
      })
      .max(2000, { error: 'must be at most 2000 characters' }),
    // Strict: anything else (the ID, location, receipt header…) can't be corrected here.
    changes: z.strictObject(
      {
        unitType: z.enum(CORRECTION_UNIT_TYPES, { error: 'must be bucket' }).optional(),
        /** Absent: unchanged. Null or blank: clear the note. */
        note: z
          .string({ error: 'must be text' })
          .trim()
          .max(2000, { error: 'must be at most 2000 characters' })
          .nullable()
          .optional()
          .transform((value) => (value === undefined ? undefined : value ? value : null)),
        receivedDate: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).optional(),
        /** Moves the unit to another project; its test holes must be chosen again there. */
        projectId: z.uuid({ error: 'must be a project ID' }).optional(),
        /**
         * Shelby tubes only (MM-T82): replaces the tube's sampling source, sample reference and
         * depth. Refused once the tube is disposed or used in a completed test.
         */
        sample: shelbySampleInputSchema.optional(),
        /**
         * Replaces the unit's test holes and summaries as a set. With `unitType: 'bucket'` on a
         * bulk soil bucket, they become the ordinary bucket's summaries (MM-T82).
         */
        holeSummaries: z
          .array(holeSummaryInputSchema, { error: 'must be a list' })
          .min(1, { error: 'needs at least one test hole summary' })
          .optional(),
      },
      { error: 'must be an object' },
    ),
  })
  .superRefine((request, ctx) => {
    const { changes } = request;
    if (Object.values(changes).every((value) => value === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes'],
        message: 'has nothing to change',
        params: { code: 'no_changes' },
      });
    }
    if (changes.projectId !== undefined && changes.holeSummaries === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', 'holeSummaries'],
        message: 'choose the test holes in the new project',
        params: { code: 'required' },
      });
    }
    const seen = new Set<string>();
    changes.holeSummaries?.forEach((summary, index) => {
      if (seen.has(summary.testHoleId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['changes', 'holeSummaries', index, 'testHoleId'],
          message: 'appears more than once on this storage unit',
          params: { code: 'duplicate_test_hole' },
        });
      }
      seen.add(summary.testHoleId);
    });
  });

export type StorageUnitCorrectionRequest = z.output<typeof storageUnitCorrectionRequestSchema>;
/** What the client sends (before trimming). */
export type StorageUnitCorrectionRequestInput = z.input<typeof storageUnitCorrectionRequestSchema>;

/** A lab request that still references the unit and must be resolved before a project change. */
export const labRequestLinkSchema = z.object({
  id: z.string(),
  /** How people refer to it, e.g. "LR-2026-0012". */
  label: z.string(),
  status: z.string(),
});
export type LabRequestLink = z.infer<typeof labRequestLinkSchema>;

/** 409 body when a project correction is blocked by unresolved lab-request links (D47). */
export const unresolvedLabLinksResponseSchema = z.object({
  code: z.literal('unresolved_lab_links'),
  links: z.array(labRequestLinkSchema),
});
export type UnresolvedLabLinksResponse = z.infer<typeof unresolvedLabLinksResponseSchema>;

/**
 * 422 body when a project correction is refused because the unit has a live disposal approval
 * (MM-T70): it must be revoked on the Disposal & Retention page first.
 */
export const disposalApprovalLiveResponseSchema = z.object({
  code: z.literal('disposal_approval_live'),
  /** The project the approval was granted under (the unit's current project). */
  projectId: z.string(),
  projectNumber: z.string(),
  message: z.string(),
});
export type DisposalApprovalLiveResponse = z.infer<typeof disposalApprovalLiveResponseSchema>;

/**
 * Minimum retain-until date shown on a unit: received date + 1 year (29 February becomes
 * 28 February). Full retention rules, holds and extensions arrive with MM-T29.
 */
export function minimumRetainUntil(receivedDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(receivedDate);
  if (!match) throw new RangeError('receivedDate must be YYYY-MM-DD');
  const year = Number(match[1]) + 1;
  const month = match[2]!;
  let day = match[3]!;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === '02' && day === '29' && !leap) day = '28';
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
}

const FIELD_LABELS: Record<StorageUnitCorrectionField, string> = {
  unitType: 'type',
  receivedDate: 'received date',
  project: 'project',
  sample: 'sampling source',
  bulkGroup: 'bulk sample',
  holeSummaries: 'test holes',
  note: 'note',
};

const summaryValueSchema = z.object({
  testHoleName: z.string(),
  type: z.enum(['all', 'sample_range', 'depth_range', 'custom']),
  sampleFrom: z.string().nullable().optional(),
  sampleTo: z.string().nullable().optional(),
  depthFrom: z.number().nullable().optional(),
  depthTo: z.number().nullable().optional(),
  depthUnit: z.enum(['ft', 'm']).nullable().optional(),
  customText: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

/** One audit value in words; audit JSON is read defensively since old events never change. */
function correctionValueText(field: StorageUnitCorrectionField, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  switch (field) {
    case 'unitType': {
      const type = z.enum(STORAGE_UNIT_TYPES).safeParse(value);
      return type.success ? storageUnitTypeLabel(type.data) : String(value);
    }
    case 'project': {
      const project = z.object({ projectNumber: z.string() }).safeParse(value);
      return project.success ? project.data.projectNumber : 'unknown';
    }
    case 'sample': {
      const sample = sampleIdentitySchema.safeParse(value);
      return sample.success ? formatSampleIdentity(sample.data) : 'unknown';
    }
    case 'bulkGroup': {
      // The group's identity as the bucket last showed it, with its "bucket n of N" place.
      const group = sampleIdentitySchema.safeParse(value);
      if (!group.success) return 'unknown';
      const place = z
        .object({ memberNumber: z.number(), memberCount: z.number() })
        .safeParse(value);
      const text = formatSampleIdentity(group.data);
      return place.success ? `${text} (${formatBucketPosition(place.data)})` : text;
    }
    case 'holeSummaries': {
      const holes = z.array(summaryValueSchema).safeParse(value);
      if (!holes.success) return 'unknown';
      if (holes.data.length === 0) return 'none';
      return holes.data
        .map((hole) => {
          const summary: Pick<
            StorageUnitHoleSummary,
            | 'type'
            | 'sampleFrom'
            | 'sampleTo'
            | 'depthFrom'
            | 'depthTo'
            | 'depthUnit'
            | 'customText'
          > = {
            type: hole.type,
            sampleFrom: hole.sampleFrom ?? null,
            sampleTo: hole.sampleTo ?? null,
            depthFrom: hole.depthFrom ?? null,
            depthTo: hole.depthTo ?? null,
            depthUnit: hole.depthUnit ?? null,
            customText: hole.customText ?? null,
          };
          const note = hole.note ? ` (${hole.note})` : '';
          return `${hole.testHoleName}: ${formatStorageUnitHoleSummary(summary)}${note}`;
        })
        .join(', ');
    }
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/**
 * A `storage_unit.corrected` event's before/after as phrases, e.g.
 * "received date 2026-10-23 → 2026-10-21".
 */
export function describeStorageUnitCorrection(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return [];
  // After a project move both projects may have a TH26-01, so the hole lists name their project
  // ("DEMO-2601 TH26-01: G1–S10 → DEMO-2602 TH26-01: G1–S10"), MM-T61.
  const moved = 'project' in before && 'project' in after;
  const value = (field: StorageUnitCorrectionField, values: Record<string, unknown>) => {
    const text = correctionValueText(field, values[field]);
    if (field !== 'holeSummaries' || !moved || text === 'none' || text === 'unknown') return text;
    return `${correctionValueText('project', values.project)} ${text}`;
  };
  return STORAGE_UNIT_CORRECTION_FIELDS.filter((field) => field in after || field in before).map(
    (field) => `${FIELD_LABELS[field]} ${value(field, before)} → ${value(field, after)}`,
  );
}
