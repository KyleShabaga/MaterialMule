import { z } from 'zod';
import { accountSnapshotSchema, personSnapshotSchema } from './lab-programs';

// Removal of tested Shelby tubes and tested bulk soil buckets (MM-T36 post-testing route).
//
// Testing and physical removal are separate facts. A completion that linked the exact unit
// (MM-T24) is the testing evidence; for a Shelby tube it also means its contents were destroyed
// during testing, so no other program can test it. Only a personal account then confirms that
// the whole unit has physically left the lab; that disposes it ("Disposed after testing").
// No retention wait, extension or hold, disposal approval or program closure applies to this
// route, and it never changes test requests, review, acceptance or program status.

export const TESTED_REMOVAL_REASONS = ['tested_shelby', 'tested_bulk'] as const;
export type TestedRemovalReason = (typeof TESTED_REMOVAL_REASONS)[number];

/** Whole-unit disposition after confirmed removal. */
export const DISPOSED_AFTER_TESTING_LABEL = 'Disposed after testing';
/** A tested Shelby tube's contents, from completion on (the tube may still be on the shelf). */
export const SHELBY_CONTENTS_DESTROYED_LABEL = 'Destroyed during testing — unusable';

export function testedRemovalReasonLabel(reason: TestedRemovalReason): string {
  return reason === 'tested_shelby' ? 'tested Shelby tube' : 'tested bulk sample';
}

/** "Retention: Not applicable — tested Shelby tube" on a unit that qualifies or was removed. */
export function testedRetentionNote(reason: TestedRemovalReason): string {
  return `Not applicable — ${testedRemovalReasonLabel(reason)}`;
}

/** One completed test that used this exact unit. */
export const testedUnitEvidenceSchema = z.object({
  testRequestId: z.string(),
  programId: z.string(),
  programNumber: z.string(),
  testCode: z.string(),
  /** The request's current status; removal never changes it. */
  requestStatus: z.string(),
  completionEventId: z.string(),
  completedAt: z.string(),
  completedBy: z.object({ account: accountSnapshotSchema, person: personSnapshotSchema }),
});
export type TestedUnitEvidence = z.infer<typeof testedUnitEvidenceSchema>;

export const testedUnitRemovalSchema = z.object({
  id: z.string(),
  reason: z.enum(TESTED_REMOVAL_REASONS),
  testRequestId: z.string(),
  programNumber: z.string(),
  testCode: z.string(),
  previousStatus: z.enum(['in_stock', 'approved_for_disposal']),
  /** Last saved location before removal, kept as history. */
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  removedBy: personSnapshotSchema,
  removedAt: z.string(),
});
export type TestedUnitRemoval = z.infer<typeof testedUnitRemovalSchema>;

/** Why a unit can't (yet) be removed through the post-testing route; null when it can. */
export const TESTED_REMOVAL_BLOCKERS = [
  'not_eligible_unit_type',
  'no_tested_evidence',
  'already_removed',
  'storage_unit_disposed',
  'location_conflict_open',
] as const;
export type TestedRemovalBlocker = (typeof TESTED_REMOVAL_BLOCKERS)[number];

/** `testing` on storage unit detail: evidence, contents and removal state. */
export const storageUnitTestingSchema = z.object({
  /** The exception this unit would use, or null for units that never qualify. */
  reason: z.enum(TESTED_REMOVAL_REASONS).nullable(),
  /** Shelby tubes only: destroyed once a completion linked this exact tube. */
  contentsDestroyed: z.boolean(),
  evidence: z.array(testedUnitEvidenceSchema),
  removal: testedUnitRemovalSchema.nullable(),
  /** Null when a personal account may confirm removal now. */
  blocker: z.enum(TESTED_REMOVAL_BLOCKERS).nullable(),
});
export type StorageUnitTesting = z.infer<typeof storageUnitTestingSchema>;

/**
 * `POST /api/storage-units/:id/tested-removal` (personal accounts only; LAB is always 403).
 * `testRequestId` names the completed test that used this exact unit; `confirmPhysicalRemoval`
 * must be true: completion alone never removes a unit. `version` is the unit version shown.
 */
export const confirmTestedRemovalRequestSchema = z.strictObject({
  testRequestId: z.uuid({ error: 'must be an ID' }),
  confirmPhysicalRemoval: z.literal(true, {
    error: 'must confirm the unit was physically removed',
  }),
  version: z.number({ error: 'is required' }).int().min(1),
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
});
export type ConfirmTestedRemovalRequest = z.output<typeof confirmTestedRemovalRequestSchema>;

/** 201 recorded; 200 an exact retry (`replayed: true`). */
export const confirmTestedRemovalResponseSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  status: z.literal('disposed'),
  version: z.number(),
  removal: testedUnitRemovalSchema,
  replayed: z.boolean(),
});
export type ConfirmTestedRemovalResponse = z.infer<typeof confirmTestedRemovalResponseSchema>;
