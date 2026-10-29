import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// MM-T30: standard whole-unit disposal. Approval (PM/PE of the project or Lab Manager) never
// disposes; removal is a separate online-only scan by a personal account that rechecks
// eligibility at that moment. MM-T36's post-testing route is separate and needs none of this.

const idSchema = z.uuid({ error: 'must be an ID' });
const reasonSchema = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'A reason is required' })
  .max(2000, { error: 'must be at most 2000 characters' });

export const DISPOSAL_BLOCKERS = [
  'not_in_stock',
  'disposed',
  'retention_not_reached',
  'on_hold',
  'program_open',
  'location_conflict',
] as const;
export type DisposalBlockerCode = (typeof DISPOSAL_BLOCKERS)[number];

export const disposalBlockerSchema = z.object({
  code: z.enum(DISPOSAL_BLOCKERS),
  /** "Retain until 2027-10-23", "On hold: claim review", "Program LP-2026-0004 open". */
  label: z.string(),
});
export type DisposalBlocker = z.infer<typeof disposalBlockerSchema>;

export const disposalApprovalSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  approvedBy: personSnapshotSchema,
  approvedAt: z.string(),
  effectiveRetainUntil: z.string(),
});
export type DisposalApproval = z.infer<typeof disposalApprovalSchema>;

export const disposalCandidateSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  unitType: z.string(),
  status: z.enum(['in_stock', 'approved_for_disposal', 'disposed']),
  location: z.object({ code: z.string(), name: z.string() }),
  receivedDate: z.string(),
  effectiveRetainUntil: z.string(),
  /** Eligible for standard approval now (in stock, date reached, no hold, programs closed). */
  eligible: z.boolean(),
  /**
   * Why it isn't (for an approved unit: what would block its removal now). For a tested unit
   * (retentionExempt) holds and retain-until are left out: they don't block its removal after
   * testing (MM-T71).
   */
  blockers: z.array(disposalBlockerSchema),
  approval: disposalApprovalSchema.nullable(),
  /** Completed testing on this exact unit: removed with "Confirm removal after testing" (MM-T36). */
  retentionExempt: z.boolean(),
});
export type DisposalCandidate = z.infer<typeof disposalCandidateSchema>;

/** Current units per page of the Disposal & Retention page (one batch approval at most). */
export const DISPOSAL_PAGE_SIZE = 200;

/** `GET /api/disposal/eligible?projectId=&page=`: current units by storage unit ID, paged. */
export const disposalCandidatesQuerySchema = z.object({
  page: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
});

export const disposalCandidatesSchema = z.object({
  projectId: z.string(),
  asOf: z.string(),
  units: z.array(disposalCandidateSchema),
  canApprove: z.boolean(),
  /** Every current (not disposed) unit of the project, across all pages. */
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type DisposalCandidates = z.infer<typeof disposalCandidatesSchema>;

/** `POST /api/disposal/approvals` */
export const approveDisposalSchema = z.strictObject({
  unitIds: z
    .array(idSchema)
    .min(1, { error: 'Choose at least one unit' })
    .max(200, { error: 'at most 200 units at once' }),
  idempotencyKey: idSchema,
});
export type ApproveDisposal = z.output<typeof approveDisposalSchema>;

export const approveDisposalResultSchema = z.object({
  batchId: z.string(),
  approvals: z.array(z.object({ id: z.string(), storageUnitId: z.string() })),
});
export type ApproveDisposalResult = z.infer<typeof approveDisposalResultSchema>;

/** `POST /api/disposal/approvals/:id/revoke` */
export const revokeDisposalSchema = z.strictObject({
  reason: reasonSchema,
  idempotencyKey: idSchema,
});
export type RevokeDisposal = z.output<typeof revokeDisposalSchema>;

/** `POST /api/disposal/remove`: one scan in Disposal scan mode (online only, never queued). */
export const removeDisposalSchema = z.strictObject({
  /** The scanned storage unit ID (any case), or the unit's UUID. */
  suNumber: z.string().trim().min(1, { error: 'Scan a storage unit' }).max(64),
  idempotencyKey: idSchema,
});
export type RemoveDisposal = z.output<typeof removeDisposalSchema>;

export const DISPOSAL_SCAN_RESULTS = ['disposed', 'not_approved', 'blocked', 'not_found'] as const;

export const disposalScanResultSchema = z.object({
  result: z.enum(DISPOSAL_SCAN_RESULTS),
  storageUnitId: z.string().nullable(),
  readableId: z.string().nullable(),
  /** For blocked: each reason; for not_approved: why (e.g. already disposed). */
  blockers: z.array(disposalBlockerSchema),
  message: z.string(),
  removedAt: z.string().nullable(),
  removedBy: personSnapshotSchema.nullable(),
  replayed: z.boolean(),
});
export type DisposalScanResult = z.infer<typeof disposalScanResultSchema>;

export const STANDARD_DISPOSAL_LABEL = 'Disposed';
