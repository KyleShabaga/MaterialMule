import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// MM-T29: retention dates, holds, extensions and retention requests. The server computes every
// date (database view unit_retention); these shapes only carry the results.

export const RETENTION_SCOPES = ['project', 'units'] as const;
export type RetentionScope = (typeof RETENTION_SCOPES)[number];

export const RETENTION_REASON_MAX_LENGTH = 2000;
const reasonSchema = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'A reason is required' })
  .max(RETENTION_REASON_MAX_LENGTH, {
    error: `must be at most ${RETENTION_REASON_MAX_LENGTH} characters`,
  });
const idSchema = z.uuid({ error: 'must be an ID' });

const scopeFields = {
  projectId: idSchema,
  scope: z.enum(RETENTION_SCOPES, { error: 'must be project or units' }),
  /** Required (1–500 units of the project) when scope is units; omitted for project. */
  unitIds: z.array(idSchema).max(500, { error: 'at most 500 units' }).optional(),
  reason: reasonSchema,
  idempotencyKey: idSchema,
};

function scopeRule<T extends { scope: RetentionScope; unitIds?: string[] }>(
  value: T,
  ctx: z.RefinementCtx,
) {
  if (value.scope === 'units' && (!value.unitIds || value.unitIds.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['unitIds'], message: 'Choose at least one unit' });
  }
  if (value.scope === 'project' && value.unitIds && value.unitIds.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['unitIds'], message: 'must be empty for a project' });
  }
}

const amountFields = {
  /** A new retain-until date (YYYY-MM-DD) … */
  retainUntil: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).optional(),
  /** … or months added to each unit's minimum retain-until. */
  extendMonths: z.number().int().min(1).max(600).optional(),
};

function amountRule<T extends { retainUntil?: string; extendMonths?: number }>(
  value: T,
  ctx: z.RefinementCtx,
) {
  if ((value.retainUntil === undefined) === (value.extendMonths === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['retainUntil'],
      message: 'Give a new retain-until date or a number of months',
    });
  }
}

/** `POST /api/retention/holds` (project PM/PE or Lab Manager). */
export const placeHoldSchema = z.strictObject(scopeFields).superRefine(scopeRule);
export type PlaceHold = z.output<typeof placeHoldSchema>;

/** `POST /api/retention/extensions` (project PM/PE or Lab Manager). */
export const setExtensionSchema = z
  .strictObject({ ...scopeFields, ...amountFields })
  .superRefine((v, ctx) => {
    scopeRule(v, ctx);
    amountRule(v, ctx);
  });
export type SetExtension = z.output<typeof setExtensionSchema>;

/** `POST /api/retention/holds/:id/release` and `…/extensions/:id/release`. */
export const releaseRetentionSchema = z.strictObject({
  reason: reasonSchema,
  /** The version last read; a stale one gets 409 `stale_retention`. */
  version: z.number({ error: 'is required' }).int().min(1),
  idempotencyKey: idSchema,
});
export type ReleaseRetention = z.output<typeof releaseRetentionSchema>;

/** `POST /api/retention/requests` (any internal personal account; never LAB). */
export const retentionRequestSchema = z
  .strictObject({ kind: z.enum(['hold', 'extension']), ...scopeFields, ...amountFields })
  .superRefine((v, ctx) => {
    scopeRule(v, ctx);
    if (v.kind === 'extension') amountRule(v, ctx);
    else if (v.retainUntil !== undefined || v.extendMonths !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['retainUntil'], message: 'only for an extension' });
    }
  });
export type RetentionRequestInput = z.output<typeof retentionRequestSchema>;

/** `POST /api/retention/requests/:id/approve` and `…/decline` (decline needs a reason). */
export const decideRetentionRequestSchema = z.strictObject({
  reason: reasonSchema.optional(),
  idempotencyKey: idSchema,
});
export type DecideRetentionRequest = z.output<typeof decideRetentionRequestSchema>;

export const retentionHoldSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scope: z.enum(RETENTION_SCOPES),
  /** Selected units (readable IDs) for a units hold; empty for a project hold. */
  units: z.array(z.object({ id: z.string(), readableId: z.string() })),
  reason: z.string(),
  placedBy: personSnapshotSchema,
  placedAt: z.string(),
  fromRequestId: z.string().nullable(),
  active: z.boolean(),
  releasedBy: personSnapshotSchema.nullable(),
  releasedAt: z.string().nullable(),
  releaseReason: z.string().nullable(),
  version: z.number().int(),
});
export type RetentionHold = z.infer<typeof retentionHoldSchema>;

export const retentionExtensionSchema = retentionHoldSchema
  .omit({ placedBy: true, placedAt: true })
  .extend({
    retainUntil: z.string().nullable(),
    extendMonths: z.number().int().nullable(),
    setBy: personSnapshotSchema,
    setAt: z.string(),
  });
export type RetentionExtension = z.infer<typeof retentionExtensionSchema>;

export const retentionRequestViewSchema = z.object({
  id: z.string(),
  kind: z.enum(['hold', 'extension']),
  scope: z.enum(RETENTION_SCOPES),
  units: z.array(z.object({ id: z.string(), readableId: z.string() })),
  retainUntil: z.string().nullable(),
  extendMonths: z.number().int().nullable(),
  reason: z.string(),
  requestedBy: personSnapshotSchema,
  requestedAt: z.string(),
  status: z.enum(['open', 'approved', 'declined']),
  decidedBy: personSnapshotSchema.nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});
export type RetentionRequestView = z.infer<typeof retentionRequestViewSchema>;

/** Per-unit calculation (database view unit_retention), as of `asOf` (business time zone). */
export const unitRetentionSchema = z.object({
  receivedDate: z.string(),
  minimumRetainUntil: z.string(),
  effectiveRetainUntil: z.string(),
  onHold: z.boolean(),
  /** Date-eligible: the effective retain-until date has been reached (not full disposal). */
  eligibleByDate: z.boolean(),
  /** Tested Shelby tube or bulk soil bucket with exact-unit completed-test evidence. */
  retentionExempt: z.boolean(),
  asOf: z.string(),
});
export type UnitRetention = z.infer<typeof unitRetentionSchema>;

/** `GET /api/storage-units/:id/retention` */
export const storageUnitRetentionSchema = z.object({
  storageUnitId: z.string(),
  projectId: z.string(),
  retention: unitRetentionSchema,
  /** Holds and extensions that cover this unit, active and released (newest first). */
  holds: z.array(retentionHoldSchema),
  extensions: z.array(retentionExtensionSchema),
  canManage: z.boolean(),
  canRequest: z.boolean(),
});
export type StorageUnitRetention = z.infer<typeof storageUnitRetentionSchema>;

/** `GET /api/projects/:id/retention` */
export const projectRetentionSchema = z.object({
  projectId: z.string(),
  holds: z.array(retentionHoldSchema),
  extensions: z.array(retentionExtensionSchema),
  requests: z.array(retentionRequestViewSchema),
  counts: z.object({ current: z.number().int(), onHold: z.number().int() }),
  canManage: z.boolean(),
  canRequest: z.boolean(),
});
export type ProjectRetention = z.infer<typeof projectRetentionSchema>;

export const retentionMutationResultSchema = z.object({
  id: z.string(),
  version: z.number().int(),
});
export type RetentionMutationResult = z.infer<typeof retentionMutationResultSchema>;

export const retentionRequestResultSchema = z.object({
  requestId: z.string(),
  actionItemId: z.string(),
});
export type RetentionRequestResult = z.infer<typeof retentionRequestResultSchema>;

/** "Retain until 2027-10-23", "On hold: claim review", "Not applicable — tested Shelby tube". */
export function retentionSummary(r: UnitRetention, unitType: string): string {
  if (r.retentionExempt) {
    return unitType === 'shelby_tube'
      ? 'Retention: Not applicable — tested Shelby tube'
      : 'Retention: Not applicable — tested bulk sample';
  }
  return `Retain until ${r.effectiveRetainUntil}${r.onHold ? ' · On hold' : ''}`;
}
