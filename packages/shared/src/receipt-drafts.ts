import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// STRATA-108: who started a receiving draft, so only that person or a verified Lab Manager may
// delete it. The server keeps ownership metadata only (draft ID, the account and person who
// started it, the deletion); a draft's contents never leave the browser that saved it (MM-T11).

/** Most draft IDs one ownership read accepts (the drafts on one computer). */
export const RECEIPT_DRAFT_OWNERSHIP_MAX = 100;

const uuid = (what: string) => z.uuid({ error: `must be a ${what} ID` });

/** Query values: a missing or blank parameter means "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * `personUserId`: on a LAB station, the person picked at the station (attribution only, it grants
 * nothing and their roles are never borrowed). A personal account omits it or sends its own ID.
 */
const personUserId = z.preprocess(blankToUndefined, uuid('staff member').optional());

/** `POST /api/receipt-drafts` body: register a draft the first time it is saved. */
export const receiptDraftRegisterRequestSchema = z.strictObject({
  draftId: uuid('draft'),
  personUserId,
});
export type ReceiptDraftRegisterRequest = z.output<typeof receiptDraftRegisterRequestSchema>;

/** `GET /api/receipt-drafts?ids=<uuid>,<uuid>&personUserId=` query. */
export const receiptDraftOwnershipQuerySchema = z.object({
  ids: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : value,
    z
      .array(uuid('draft'))
      .min(1, { error: 'name at least one draft' })
      .max(RECEIPT_DRAFT_OWNERSHIP_MAX, {
        error: `at most ${RECEIPT_DRAFT_OWNERSHIP_MAX} drafts`,
      }),
  ),
  personUserId,
});
export type ReceiptDraftOwnershipQuery = z.output<typeof receiptDraftOwnershipQuerySchema>;

/** `POST /api/receipt-drafts/:draftId/delete` path parameter. */
export const receiptDraftIdParamSchema = z.object({ draftId: uuid('draft') });

/** `POST /api/receipt-drafts/:draftId/delete` body. */
export const receiptDraftDeleteRequestSchema = z.strictObject({ personUserId });
export type ReceiptDraftDeleteRequest = z.output<typeof receiptDraftDeleteRequestSchema>;

/**
 * Why the current actor may or may not delete a draft:
 * - `starter`: they started it (on LAB: this LAB account, with the starter picked now);
 * - `lab_manager`: a personal account holding the Lab Manager role, checked as it stands;
 * - `not_starter`: someone else started it;
 * - `other_account`: it was started on another account (another station or person);
 * - `pick_person`: a LAB station must pick who is deleting first;
 * - `unregistered`: saved before ownership was recorded; only a Lab Manager may delete it.
 */
export const RECEIPT_DRAFT_DELETE_REASONS = [
  'starter',
  'lab_manager',
  'not_starter',
  'other_account',
  'pick_person',
  'unregistered',
] as const;
export type ReceiptDraftDeleteReason = (typeof RECEIPT_DRAFT_DELETE_REASONS)[number];

export const receiptDraftOwnershipSchema = z.object({
  draftId: z.string(),
  /** False for a draft saved before ownership was recorded (legacy): no starter is invented. */
  registered: z.boolean(),
  /** Who started it, with their current name; null when unregistered. */
  starter: personSnapshotSchema.nullable(),
  /** Started on the shared LAB station rather than a personal account. */
  startedOnStation: z.boolean(),
  createdAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  canDelete: z.boolean(),
  reason: z.enum(RECEIPT_DRAFT_DELETE_REASONS),
});
export type ReceiptDraftOwnership = z.infer<typeof receiptDraftOwnershipSchema>;

/** `GET /api/receipt-drafts` response, in the order asked for. */
export const receiptDraftOwnershipListSchema = z.object({
  items: z.array(receiptDraftOwnershipSchema),
});
export type ReceiptDraftOwnershipList = z.infer<typeof receiptDraftOwnershipListSchema>;

/**
 * `POST /api/receipt-drafts/:draftId/delete` 200 response. The browser removes its copy only
 * after this. 403 `draft_delete_forbidden` carries `reason`; a repeat answers 200 again.
 */
export const receiptDraftDeletedSchema = z.object({
  draftId: z.string(),
  deletedAt: z.string(),
  reason: z.enum(['starter', 'lab_manager']),
});
export type ReceiptDraftDeleted = z.infer<typeof receiptDraftDeletedSchema>;

export const receiptDraftDeleteForbiddenSchema = z.object({
  code: z.literal('draft_delete_forbidden'),
  reason: z.enum(RECEIPT_DRAFT_DELETE_REASONS),
  starter: personSnapshotSchema.nullable(),
});

/** "Only Jordan Lab or a Lab Manager can delete it" (Kyle, STRATA-108). */
export function receiptDraftDeleteHint(
  ownership: Pick<ReceiptDraftOwnership, 'starter' | 'reason'>,
): string {
  if (ownership.reason === 'pick_person') {
    return 'Choose who is working at this station to delete it';
  }
  return ownership.starter
    ? `Only ${ownership.starter.name} or a Lab Manager can delete it`
    : 'Only a Lab Manager can delete it';
}
