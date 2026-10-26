import { z } from 'zod';

// Online receipt confirmation, `POST /api/receipts` (TRP-T09). Receiving is per storage unit with
// one SAMPLE#/DEPTH summary per test hole; there are no individual sample records here.

/** Hard limit on storage units per receipt (owner decision 2026-10-25; also a database CHECK). */
export const MAX_UNITS_PER_RECEIPT = 50;

export const HOLE_SUMMARY_TYPES = ['all', 'sample_range', 'depth_range', 'custom'] as const;
export type HoleSummaryType = (typeof HOLE_SUMMARY_TYPES)[number];

/** Unit types this increment can confirm. Shelby tubes and bulk containers arrive in TRP-T36. */
export const RECEIPT_UNIT_TYPES = ['bucket'] as const;

/** Largest depth `numeric(8, 2)` can hold. */
const MAX_DEPTH = 999_999.99;

/** Trimmed optional text: absent, null and blank all become null so retries hash the same. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `must be at most ${max} characters` })
    .nullish()
    .transform((value) => (value ? value : null));

const sampleLabel = optionalText(20);

const depth = z
  .number({ error: 'must be a number' })
  .min(0, { error: 'must be 0 or more' })
  .max(MAX_DEPTH, { error: `must be at most ${MAX_DEPTH}` })
  .refine((value) => Math.round(value * 100) / 100 === value, {
    error: 'must have at most two decimal places',
    params: { code: 'too_precise' },
  })
  .nullish()
  .transform((value) => value ?? null);

export const holeSummaryInputSchema = z
  .object({
    testHoleId: z.uuid({ error: 'must be a test hole ID' }),
    type: z.enum(HOLE_SUMMARY_TYPES, { error: 'must be all, sample_range, depth_range or custom' }),
    sampleFrom: sampleLabel,
    sampleTo: sampleLabel,
    depthFrom: depth,
    depthTo: depth,
    depthUnit: z
      .enum(['ft', 'm'], { error: 'must be ft or m' })
      .nullish()
      .transform((value) => value ?? null),
    customText: optionalText(500),
    note: optionalText(500),
  })
  .superRefine((summary, ctx) => {
    // Same shape rules as the database's summary_shape_check (TRP-T02).
    const issue = (field: string, code: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message, params: { code } });
    const mustBeEmpty = (fields: (keyof typeof summary)[]) => {
      for (const field of fields) {
        if (summary[field] !== null) {
          issue(field, 'not_allowed', `must be empty for a ${summary.type} summary`);
        }
      }
    };
    switch (summary.type) {
      case 'all':
        mustBeEmpty(['sampleFrom', 'sampleTo', 'depthFrom', 'depthTo', 'depthUnit', 'customText']);
        break;
      case 'sample_range':
        if (summary.sampleFrom === null) issue('sampleFrom', 'required', 'is required');
        if (summary.sampleTo === null) issue('sampleTo', 'required', 'is required');
        mustBeEmpty(['depthFrom', 'depthTo', 'depthUnit', 'customText']);
        break;
      case 'depth_range':
        if (summary.depthFrom === null) issue('depthFrom', 'required', 'is required');
        if (summary.depthTo === null) issue('depthTo', 'required', 'is required');
        if (summary.depthUnit === null) issue('depthUnit', 'required', 'is required (ft or m)');
        if (
          summary.depthFrom !== null &&
          summary.depthTo !== null &&
          summary.depthTo < summary.depthFrom
        ) {
          issue('depthTo', 'depth_range_reversed', 'must be greater than or equal to depth from');
        }
        mustBeEmpty(['sampleFrom', 'sampleTo', 'customText']);
        break;
      case 'custom':
        if (summary.customText === null) issue('customText', 'required', 'is required');
        mustBeEmpty(['sampleFrom', 'sampleTo', 'depthFrom', 'depthTo', 'depthUnit']);
        break;
    }
  });

export type HoleSummaryInput = z.infer<typeof holeSummaryInputSchema>;

export const receiptUnitInputSchema = z
  .object({
    /** The draft row's own ID, echoed back so the client can match issued IDs to its rows. */
    clientRowId: z
      .string({ error: 'is required' })
      .trim()
      .min(1, { error: 'is required' })
      .max(64, { error: 'must be at most 64 characters' }),
    unitType: z.enum(RECEIPT_UNIT_TYPES, { error: 'must be bucket' }),
    note: optionalText(2000),
    holeSummaries: z
      .array(holeSummaryInputSchema, { error: 'is required' })
      .min(1, { error: 'needs at least one test hole summary' }),
  })
  .superRefine((unit, ctx) => {
    const seen = new Set<string>();
    unit.holeSummaries.forEach((summary, index) => {
      if (seen.has(summary.testHoleId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['holeSummaries', index, 'testHoleId'],
          message: 'appears more than once on this storage unit',
          params: { code: 'duplicate_test_hole' },
        });
      }
      seen.add(summary.testHoleId);
    });
  });

export type ReceiptUnitInput = z.infer<typeof receiptUnitInputSchema>;

export const confirmReceiptRequestSchema = z
  .object({
    /** UUID created with the draft; retries with the same key return the original result. */
    idempotencyKey: z.uuid({ error: 'must be a UUID' }),
    projectId: z.uuid({ error: 'must be a project ID' }),
    receivedDate: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }),
    receiverUserId: z.uuid({ error: 'must be a staff member ID' }),
    description: optionalText(2000),
    units: z
      .array(receiptUnitInputSchema, { error: 'is required' })
      .min(1, { error: 'needs at least one storage unit' })
      .max(MAX_UNITS_PER_RECEIPT, {
        error: `can have at most ${MAX_UNITS_PER_RECEIPT} storage units`,
      }),
  })
  .superRefine((receipt, ctx) => {
    const seen = new Set<string>();
    receipt.units.forEach((unit, index) => {
      if (seen.has(unit.clientRowId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'clientRowId'],
          message: 'appears more than once in this receipt',
          params: { code: 'duplicate_client_row' },
        });
      }
      seen.add(unit.clientRowId);
    });
  });

export type ConfirmReceiptRequest = z.infer<typeof confirmReceiptRequestSchema>;
/** What the client sends (before trimming and defaults). */
export type ConfirmReceiptRequestInput = z.input<typeof confirmReceiptRequestSchema>;

export const confirmReceiptResponseSchema = z.object({
  receiptId: z.string(),
  units: z.array(
    z.object({
      clientRowId: z.string(),
      /** Internal UUID of the storage unit. */
      storageUnitId: z.string(),
      /** Permanent readable ID printed on the label, e.g. BKT-2026-000001. */
      suNumber: z.string(),
    }),
  ),
});

export type ConfirmReceiptResponse = z.infer<typeof confirmReceiptResponseSchema>;

/** One field-level problem, shaped so the receiving wizard (T10) can show it next to the field. */
export interface FieldError {
  /** Dotted path into the request, e.g. `units.0.holeSummaries.1.depthTo`. */
  field: string;
  code: string;
  message: string;
}

/** Error body for 400 (validation_failed) and 422 (e.g. test_hole_not_in_project). */
export interface ReceiptErrorBody {
  code: string;
  errors?: FieldError[];
}

/** Converts zod issues to field errors; refinements carry their code in `params.code`. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => {
    const params = (issue as { params?: { code?: unknown } }).params;
    const code =
      issue.code === 'custom' && typeof params?.code === 'string' ? params.code : issue.code;
    return { field: issue.path.map(String).join('.'), code, message: issue.message };
  });
}
